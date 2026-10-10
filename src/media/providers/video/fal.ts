// fal.ai queue API for text-to-video: submit, poll status_url, read response_url -> video.url.
import { fetchBytes, fetchJson } from "../http.ts";

interface QueueSubmit {
  request_id: string;
  status_url: string;
  response_url: string;
}

export interface VideoRequest {
  prompt: string;
  aspect: "16:9" | "1:1" | "9:16";
  /** Seconds; models support a small fixed set (e.g. 5 or 10). */
  duration?: 5 | 10;
  timeoutMs?: number;
}

export async function falVideo(apiKey: string, req: VideoRequest): Promise<{ bytes: Buffer; model: string }> {
  const model = process.env.AUTOCM_FAL_VIDEO_MODEL || "fal-ai/kling-video/v2.1/standard/text-to-video";
  const headers = { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" };
  const deadline = Date.now() + (req.timeoutMs ?? 8 * 60_000);

  const job = await fetchJson<QueueSubmit>(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: req.prompt, aspect_ratio: req.aspect, duration: String(req.duration ?? 5) }),
  });

  for (;;) {
    if (Date.now() > deadline) throw new Error(`fal video timed out (${job.request_id})`);
    const st = await fetchJson<{ status: string }>(job.status_url, { headers, timeoutMs: 30_000 });
    if (st.status === "COMPLETED") break;
    if (st.status !== "IN_QUEUE" && st.status !== "IN_PROGRESS") throw new Error(`fal video status ${st.status}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }

  const out = await fetchJson<{ video?: { url?: string } }>(job.response_url, { headers, timeoutMs: 30_000 });
  const url = out.video?.url;
  if (!url) throw new Error("fal video: no video url in response");
  const { bytes } = await fetchBytes(url, 300_000);
  return { bytes, model };
}
