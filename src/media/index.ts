// STUB — stream B (media) owns this module. Signature is frozen (contracts-v1).
import type { Brief, Capabilities, Draft, MediaResult, Product } from "../core/types.ts";

/**
 * Produce the media for a post into `outDir`. For brief.media_kind "none" returns no files.
 * Must fall back (ai_image -> template, ai_video -> remotion) instead of throwing when a provider fails,
 * and set `fallback_from`. `preview_frames` must hold PNGs for visual QA (the image itself, or ~5 video frames).
 */
export async function produceMedia(
  brief: Brief,
  draft: Draft,
  product: Product,
  caps: Capabilities,
  outDir: string,
): Promise<MediaResult> {
  if (brief.media_kind === "none") return { kind: "none", files: [], preview_frames: [], notes: [] };
  throw new Error(`produceMedia: media kind "${brief.media_kind}" not implemented yet (${product.config.slug}, ${outDir}, ${JSON.stringify(caps)}, ${draft.text.length})`);
}

/** CLI `render-fixture`: render fixtures/<file> ({brief, draft}) for a product, print the result. */
export async function renderFixture(fixturePath: string, productSlug: string): Promise<MediaResult> {
  throw new Error(`renderFixture not implemented yet (${fixturePath}, ${productSlug})`);
}
