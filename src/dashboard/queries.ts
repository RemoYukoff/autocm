// Read side of the dashboard: slots, posts and header stats shaped for the UI.
import path from "node:path";
import { loadProducts } from "../core/config.ts";
import { getDb } from "../core/db/index.ts";
import { env } from "../core/env.ts";
import { OUT_DIR } from "../core/paths.ts";
import type { MediaResult, PostRow, PostStatus, Product } from "../core/types.ts";
import type { SlotRow } from "../scheduler/index.ts";
import { countPublishedBetween, weightedLength } from "../safety/guards.ts";
import { pausedReason } from "../safety/pause.ts";
import { dayRangeUtc } from "../safety/time.ts";

/** Slot statuses the scheduler still acts on. */
export const ACTIVE_SLOT_STATUSES = ["pending", "claimed", "generated"] as const;
export const HISTORY_STATUSES: PostStatus[] = ["published", "dry_run", "rejected", "failed", "qa_failed"];

export interface MediaView {
  url: string;
  mime: string;
  width: number;
  height: number;
  duration_s?: number;
  poster?: string;
}

export interface PostView {
  id: number;
  product: string;
  slot_id: number | null;
  status: PostStatus;
  format: string | null;
  media_kind: string | null;
  fallback_from: string | null;
  pillar: string | null;
  angle: string | null;
  hook_idea: string | null;
  rationale: string | null;
  text: string | null;
  weighted_length: number | null;
  alt_text: string | null;
  media: MediaView[];
  url: string | null;
  tweet_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface SlotView {
  id: number;
  product: string;
  scheduled_at: string;
  generate_at: string;
  status: SlotRow["status"];
  claimed_at: string | null;
  post: PostView | null;
}

export interface ProductView {
  slug: string;
  name: string;
  handle: string | null;
  timezone: string;
  daily_cap: number;
  today_count: number;
  live: boolean;
  enabled: boolean;
  color: string;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** `/media/<path relative to OUT_DIR>` for files inside OUT_DIR; null for anything else. */
export function mediaUrl(file: string): string | null {
  const root = path.resolve(OUT_DIR);
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, abs);
  if (!rel) return null;
  return `/media/${rel.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function postView(p: PostRow): PostView {
  const media = parseJson<Partial<MediaResult>>(p.media_json);
  const brief = parseJson<Record<string, unknown>>(p.brief_json);
  const poster = (media?.preview_frames ?? []).map(mediaUrl).find((u): u is string => !!u);
  const files: MediaView[] = [];
  for (const f of media?.files ?? []) {
    const url = mediaUrl(f.path);
    if (!url) continue;
    files.push({
      url,
      mime: f.mime,
      width: f.width,
      height: f.height,
      duration_s: f.duration_s,
      poster: f.mime.startsWith("video/") ? poster : undefined,
    });
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    id: p.id,
    product: p.product,
    slot_id: p.slot_id,
    status: p.status,
    format: p.format,
    media_kind: p.media_kind,
    fallback_from: media?.fallback_from ?? null,
    pillar: p.pillar ?? str(brief?.pillar),
    angle: p.angle ?? str(brief?.angle),
    hook_idea: str(brief?.hook_idea),
    rationale: str(brief?.rationale),
    text: p.text,
    weighted_length: p.text ? weightedLength(p.text).length : null,
    alt_text: p.alt_text,
    media: files,
    url: p.url,
    tweet_id: p.tweet_id,
    error: p.error,
    created_at: p.created_at,
    updated_at: p.updated_at,
    published_at: p.published_at,
  };
}

export function getSlot(id: number): SlotRow | undefined {
  return getDb().prepare("SELECT * FROM slots WHERE id = ?").get(id) as SlotRow | undefined;
}

/** The slot a post is attached to (slot.post_id = post), if any. */
export function slotOfPost(postId: number): SlotRow | undefined {
  return getDb().prepare("SELECT * FROM slots WHERE post_id = ? ORDER BY id DESC LIMIT 1").get(postId) as SlotRow | undefined;
}

/** The post a slot shows: its linked post, or the newest post generated for it (e.g. while generating). */
function slotPost(slot: SlotRow): PostRow | undefined {
  const db = getDb();
  if (slot.post_id) return db.prepare("SELECT * FROM posts WHERE id = ?").get(slot.post_id) as PostRow | undefined;
  if (slot.status === "claimed") {
    return db.prepare("SELECT * FROM posts WHERE slot_id = ? ORDER BY id DESC LIMIT 1").get(slot.id) as PostRow | undefined;
  }
  return undefined;
}

/**
 * Slots still ahead: everything the scheduler will act on (pending / claimed / generated, even if a guard
 * is holding it past its time), plus future slots that were skipped or failed so they can be regenerated.
 */
export function upcomingSlots(now = new Date(), limit = 60): SlotView[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM slots
       WHERE status IN ('pending','claimed','generated')
          OR (status IN ('skipped','failed') AND scheduled_at > ?)
       ORDER BY scheduled_at LIMIT ?`,
    )
    .all(now.toISOString(), limit) as unknown as SlotRow[];
  return rows.map((s) => {
    const p = slotPost(s);
    return { id: s.id, product: s.product, scheduled_at: s.scheduled_at, generate_at: s.generate_at, status: s.status, claimed_at: s.claimed_at, post: p ? postView(p) : null };
  });
}

/** Approved posts that no active slot will publish (e.g. made with `generate` or from the dashboard). */
export function readyPosts(limit = 100): PostView[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM posts p WHERE p.status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.post_id = p.id AND s.status IN ('pending','claimed','generated'))
       ORDER BY p.created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as PostRow[];
  return rows.map(postView);
}

/** Posts that are finished one way or another, newest first. */
export function historyPosts(offset = 0, limit = 50): { posts: PostView[]; total: number } {
  const marks = HISTORY_STATUSES.map(() => "?").join(",");
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM posts WHERE status IN (${marks}) ORDER BY COALESCE(published_at, updated_at) DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...HISTORY_STATUSES, limit, offset) as unknown as PostRow[];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE status IN (${marks})`).get(...HISTORY_STATUSES) as { n: number };
  return { posts: rows.map(postView), total: Number(total.n) };
}

function safeProducts(): Product[] {
  try {
    return loadProducts();
  } catch {
    return [];
  }
}

export function productViews(now = new Date()): ProductView[] {
  return safeProducts().map((p) => {
    const c = p.config;
    const today = dayRangeUtc(now, c.timezone);
    return {
      slug: c.slug,
      name: c.name,
      handle: c.handle ? c.handle.replace(/^@/, "") : null,
      timezone: c.timezone,
      daily_cap: c.cadence.daily_cap,
      today_count: countPublishedBetween(today.start, today.end, c.slug),
      live: env.mode === "live" && p.xCreds !== null,
      enabled: c.enabled,
      color: c.brand.colors.primary,
    };
  });
}

export function headerState(now = new Date()) {
  return { now: now.toISOString(), mode: env.mode, paused: pausedReason(), global_daily_cap: env.globalDailyCap, products: productViews(now) };
}
