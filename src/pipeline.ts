// STUB — stream A (agents) owns this module. Signature is frozen (contracts-v1).
import type { Format, PostRow } from "./core/types.ts";

export interface GenerateOptions {
  /** Force a format instead of letting the strategist decide. */
  format?: Format;
  slotId?: number;
}

/**
 * Full generation for one post: strategist -> dedupe -> copywriter -> media -> critic (with regenerations).
 * Leaves the post `approved` (ready to publish) or `rejected`. Never publishes.
 */
export async function generatePost(productSlug: string, opts: GenerateOptions = {}): Promise<PostRow> {
  throw new Error(`generatePost not implemented yet (${productSlug}, ${JSON.stringify(opts)})`);
}
