// STUB — stream C (publish/ops) owns this module. Signature is frozen (contracts-v1).
import type { GuardResult, Product } from "../core/types.ts";

/** Checks run right before any X call: kill switch, caps, min gap, duplicates. */
export function checkGuards(product: Product, text: string): GuardResult {
  return { ok: false, reason: `guards not implemented yet (${product.config.slug}, ${text.length})` };
}
