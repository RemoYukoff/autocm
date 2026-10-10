// Gemini image generation: models/<model>:generateContent with responseModalities IMAGE; image comes back as inlineData.
import { fetchJson } from "../http.ts";
import type { ImageRequest, ImageResult } from "./index.ts";

interface GeminiResponse {
  candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
}

export async function geminiImage(apiKey: string, req: ImageRequest): Promise<ImageResult> {
  const model = process.env.AUTOCM_GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  const json = await fetchJson<GeminiResponse>(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: req.prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: req.aspect } },
    }),
    signal: req.signal,
  });
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("gemini: no image in response");
  return { bytes: Buffer.from(part.inlineData.data, "base64"), mime: part.inlineData.mimeType ?? "image/png", provider: "gemini", model };
}
