// OpenAI Images API: POST /v1/images/generations, gpt-image-1 returns b64_json.
import { fetchJson } from "../http.ts";
import type { ImageRequest, ImageResult } from "./index.ts";

const SIZES = { "16:9": "1536x1024", "4:5": "1024x1536", "1:1": "1024x1024" } as const;

export async function openaiImage(apiKey: string, req: ImageRequest): Promise<ImageResult> {
  const model = process.env.AUTOCM_OPENAI_IMAGE_MODEL || "gpt-image-1";
  const json = await fetchJson<{ data?: { b64_json?: string }[] }>("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: req.prompt, size: SIZES[req.aspect], quality: "medium", n: 1 }),
    signal: req.signal,
    timeoutMs: 180_000,
  });
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("openai: no image in response");
  return { bytes: Buffer.from(b64, "base64"), mime: "image/png", provider: "openai", model };
}
