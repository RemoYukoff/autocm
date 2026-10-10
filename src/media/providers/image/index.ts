// AI image providers, picked by which API key is present (src/core/env.ts). Each returns raw image bytes;
// the caller composites brand text on top, so prompts always ask for no text.
import { env } from "../../../core/env.ts";
import { falImage } from "./fal.ts";
import { geminiImage } from "./gemini.ts";
import { openaiImage } from "./openai.ts";

export interface ImageRequest {
  prompt: string;
  /** Target aspect; providers map it to their nearest supported size. */
  aspect: "16:9" | "4:5" | "1:1";
  signal?: AbortSignal;
}

export interface ImageResult {
  bytes: Buffer;
  mime: string;
  provider: string;
  model: string;
}

export interface ImageProvider {
  name: "openai" | "gemini" | "fal";
  generate(req: ImageRequest): Promise<ImageResult>;
}

/** First provider with a key, in the order OpenAI, Gemini, fal. Null when none is configured. */
export function pickImageProvider(keys = { openai: env.openaiKey, gemini: env.geminiKey, fal: env.falKey }): ImageProvider | null {
  if (keys.openai) return { name: "openai", generate: (r) => openaiImage(keys.openai!, r) };
  if (keys.gemini) return { name: "gemini", generate: (r) => geminiImage(keys.gemini!, r) };
  if (keys.fal) return { name: "fal", generate: (r) => falImage(keys.fal!, r) };
  return null;
}

/** Background-only prompt: brand mood, no text, empty area for the headline. */
export function backgroundPrompt(visualDirection: string, colors: { bg: string; primary: string; accent: string }): string {
  return [
    visualDirection.trim(),
    `Style: minimal, premium B2B software aesthetic, dark near-black background (${colors.bg}) with subtle ${colors.primary} and ${colors.accent} accents, soft light, clean abstract shapes, high detail.`,
    "Composition: keep the left half calm and empty for overlaid headline text; subject on the right.",
    "Absolutely no text, letters, numbers, logos, watermarks or UI labels.",
  ].join(" ");
}
