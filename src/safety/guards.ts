// Stream C (publish/ops). Signature of checkGuards is frozen (contracts-v1).
import twitterText from "twitter-text";
import { getDb } from "../core/db/index.ts";
import { env } from "../core/env.ts";
import type { GuardResult, PostRow, PostStatus, Product } from "../core/types.ts";
import { pausedReason } from "./pause.ts";
import { findDuplicate } from "./text.ts";
import { dayRangeUtc } from "./time.ts";

export const MAX_WEIGHTED_LENGTH = 280;
const DEDUPE_WINDOW = 200;

/** Statuses that count as "already went out" for caps and min gap. */
const COUNTED: PostStatus[] = ["published"];

function marks(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** Posts that went out within [start, end), optionally for one product. */
export function countPublishedBetween(start: string, end: string, product?: string): number {
  const statuses = COUNTED;
  const where = product ? "AND product = ?" : "";
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM posts WHERE status IN (${marks(statuses.length)})
       AND published_at >= ? AND published_at < ? ${where}`,
    )
    .get(...statuses, start, end, ...(product ? [product] : [])) as { n: number };
  return Number(row.n);
}

/** ISO timestamp of the product's last post that went out, or null. */
export function lastPublishedAt(product: string): string | null {
  const statuses = COUNTED;
  const row = getDb()
    .prepare(
      `SELECT MAX(published_at) AS t FROM posts WHERE product = ? AND status IN (${marks(statuses.length)})
       AND published_at IS NOT NULL`,
    )
    .get(product, ...statuses) as { t: string | null };
  return row.t ?? null;
}

/** Weighted tweet length as X counts it (URLs = 23, CJK/emoji = 2). */
export function weightedLength(text: string): { length: number; valid: boolean } {
  const r = twitterText.parseTweet(text);
  return { length: r.weightedLength, valid: r.valid };
}

/** Checks run right before any X call: kill switch, caps, min gap, duplicates. */
export function checkGuards(product: Product, text: string): GuardResult {
  const c = product.config;
  const slug = c.slug;
  const now = new Date();

  // (a) kill switch
  const paused = pausedReason();
  if (paused) return { ok: false, reason: `paused: ${paused}` };

  // (b) product enabled
  if (!c.enabled) return { ok: false, reason: `product ${slug} is disabled` };

  // (b2) X session: without a connected account there is nowhere to publish; the post waits until it is connected
  if (!product.xAccount) return { ok: false, reason: `X not connected for ${slug} (connect it from the dashboard)` };

  // (g) length / validity (cheap, checked early)
  if (!text.trim()) return { ok: false, reason: "empty text" };
  const len = weightedLength(text);
  if (len.length > MAX_WEIGHTED_LENGTH || !len.valid) {
    return { ok: false, reason: `text too long or invalid: weighted length ${len.length}/${MAX_WEIGHTED_LENGTH}` };
  }

  // (c) per-product daily cap, "today" in the product timezone
  const today = dayRangeUtc(now, c.timezone);
  const productCount = countPublishedBetween(today.start, today.end, slug);
  if (productCount >= c.cadence.daily_cap) {
    return { ok: false, reason: `daily cap reached for ${slug}: ${productCount}/${c.cadence.daily_cap} on ${today.label} (${c.timezone})` };
  }

  // (d) global daily cap across products (same local-day window as the product)
  const globalCount = countPublishedBetween(today.start, today.end);
  if (globalCount >= env.globalDailyCap) {
    return { ok: false, reason: `global daily cap reached: ${globalCount}/${env.globalDailyCap}` };
  }

  // (e) min gap since the product's last post
  const last = lastPublishedAt(slug);
  if (last && c.cadence.min_gap_min > 0) {
    const gapMin = (now.getTime() - Date.parse(last)) / 60_000;
    if (gapMin < c.cadence.min_gap_min) {
      return { ok: false, reason: `min gap: last post ${Math.floor(gapMin)} min ago, need ${c.cadence.min_gap_min}` };
    }
  }

  // (f) duplicates vs the product's last 200 posts that went out 
  const history = getDb()
    .prepare(
      `SELECT id, text, text_hash FROM posts WHERE product = ? AND status = 'published'
       ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`,
    )
    .all(slug, DEDUPE_WINDOW) as unknown as Pick<PostRow, "id" | "text" | "text_hash">[];
  const dup = findDuplicate(text, history);
  if (dup) {
    return {
      ok: false,
      reason: `${dup.exact ? "duplicate" : "near-duplicate"} of post #${dup.match.id} (similarity ${dup.similarity.toFixed(2)})`,
    };
  }

  return { ok: true };
}
