// STUB — stream C (publish/ops) owns this module. Signatures are frozen (contracts-v1).
import type { PostRow, Product, PublishResult } from "../core/types.ts";

/** Run guards, then publish to X (live) or write a dry-run preview. Updates the post row. */
export async function publishPost(post: PostRow, product: Product): Promise<PublishResult> {
  throw new Error(`publishPost not implemented yet (${post.id}, ${product.config.slug})`);
}

/** CLI `x whoami`: verify credentials for a product. */
export async function xWhoami(product: Product): Promise<{ id: string; username: string }> {
  throw new Error(`xWhoami not implemented yet (${product.config.slug})`);
}
