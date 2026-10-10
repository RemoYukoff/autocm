// fal.ai synchronous endpoint (https://fal.run/<model>); FLUX returns images[].url.
import { fetchBytes, fetchJson } from "../http.ts";
import type { ImageRequest, ImageResult } from "./index.ts";

const SIZES = { "16:9": "landscape_16_9", "4:5": "portrait_4_3", "1:1": "square_hd" } as const;

export async function falImage(apiKey: string, req: ImageRequest): Promise<ImageResult> {
  const model = process.env.AUTOCM_FAL_IMAGE_MODEL || "fal-ai/flux/dev";
  const json = await fetchJson<{ images?: { url?: string; content_type?: string }[] }>(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: req.prompt, image_size: SIZES[req.aspect], num_images: 1, enable_safety_checker: true }),
    signal: req.signal,
  });
  const url = json.images?.[0]?.url;
  if (!url) throw new Error("fal: no image in response");
  const { bytes, mime } = await fetchBytes(url);
  return { bytes, mime: json.images?.[0]?.content_type ?? mime, provider: "fal", model };
}
