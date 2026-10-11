// Read back how published posts did on X, so the marketer can learn from it (src/agents/context.ts).
import { getDb, logEvent, savePostMetrics } from "../core/db/index.ts";
import { track } from "../core/inflight.ts";
import { log } from "../core/log.ts";
import type { PostRow, Product } from "../core/types.ts";
import { isPaused } from "../safety/pause.ts";
import { getXClient } from "./x.ts";
// Side effect: registers the browser client (src/x/) as the default XClient.
import "../x/index.ts";

/** Posts are followed for two weeks; most engagement arrives in the first days. */
const FOLLOW_MS = 14 * 86_400_000;
/** First read an hour after publishing, then at most every 6 hours. */
const FIRST_READ_MS = 3_600_000;
const REREAD_MS = 6 * 3_600_000;

/** Published posts of the product whose numbers are due for a (re)read. */
export function postsDueForMetrics(product: string, now = Date.now()): PostRow[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM posts WHERE product = ? AND status = 'published' AND tweet_id IS NOT NULL
         AND published_at > ? AND published_at < ? AND (metrics_at IS NULL OR metrics_at < ?)
       ORDER BY published_at DESC`,
    )
    .all(product, iso(now - FOLLOW_MS), iso(now - FIRST_READ_MS), iso(now - REREAD_MS)) as unknown as PostRow[];
}

/** Read and store the numbers of the product's due posts. Returns how many were updated. */
export async function refreshMetrics(product: Product): Promise<number> {
  const slug = product.config.slug;
  if (!product.xAccount || isPaused(slug)) return 0;
  const due = postsDueForMetrics(slug);
  if (!due.length) return 0;
  const found = await track(getXClient(product).metrics(due.map((p) => p.tweet_id!)));
  for (const p of due) {
    const m = found.get(p.tweet_id!);
    if (m) savePostMetrics(p.id, m);
  }
  logEvent("metrics_read", { product: slug, payload: { due: due.length, found: found.size } });
  log.info({ product: slug, due: due.length, found: found.size }, "post metrics read");
  return found.size;
}
