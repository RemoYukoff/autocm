// Read side of the dashboard: slots, posts and header stats shaped for the UI.
import path from "node:path";
import { listProductSlugs, loadProduct, loadProducts } from "../core/config.ts";
import { getDb, getXAccount, listXAccounts } from "../core/db/index.ts";
import { env } from "../core/env.ts";
import { OUT_DIR } from "../core/paths.ts";
import type { MediaResult, PostRow, PostStatus, Product, XAccount } from "../core/types.ts";
import type { SlotRow } from "../scheduler/index.ts";
import { countPublishedBetween, weightedLength } from "../safety/guards.ts";
import { pausedReason } from "../safety/pause.ts";
import { dayRangeUtc } from "../safety/time.ts";
import { avatarFile } from "./accounts.ts";


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
  status: SlotRow["status"];
  claimed_at: string | null;
  post: PostView | null;
}

export interface XAccountView {
  handle: string;
  name: string | null;
  avatar_url: string | null;
  connected_at: string;
  last_ok_at: string | null;
  error: string | null;
}

export interface ProductView {
  slug: string;
  name: string;
  /** @handle shown on previews: the connected account's, else product.yaml's `handle`. */
  handle: string | null;
  timezone: string;
  daily_cap: number;
  today_count: number;
  live: boolean;
  enabled: boolean;
  color: string;
  x: XAccountView | null;
  /** "website": logged in to X, waiting for the product's website; "ready": posting. */
  setup: "website" | "ready";
  /** Set when product.yaml does not load (the account can only be deleted). */
  invalid: string | null;
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
 * What the bot is about to publish: every slot the scheduler still acts on (pending / claimed / generated, even if
 * a guard is holding it past its time). Vetoed, failed and published slots drop out.
 */
export function upcomingSlots(limit = 60, product?: string): SlotView[] {
  const rows = getDb()
    .prepare("SELECT * FROM slots WHERE status IN ('pending','claimed','generated') AND (? IS NULL OR product = ?) ORDER BY scheduled_at LIMIT ?")
    .all(product ?? null, product ?? null, limit) as unknown as SlotRow[];
  return rows.map((s) => {
    const p = slotPost(s);
    return { id: s.id, product: s.product, scheduled_at: s.scheduled_at, status: s.status, claimed_at: s.claimed_at, post: p ? postView(p) : null };
  });
}

/** Every product; one broken product.yaml must not hide the others, so fall back to loading one by one. */
function safeProducts(): (Product | { slug: string; error: string })[] {
  try {
    return loadProducts();
  } catch {
    return listProductSlugs().map((slug) => {
      try {
        return loadProduct(slug);
      } catch (e) {
        return { slug, error: (e as Error).message.split("\n").slice(0, 2).join(" ") };
      }
    });
  }
}

function xView(slug: string, a: XAccount | null): XAccountView | null {
  if (!a) return null;
  return {
    handle: a.handle.replace(/^@/, ""),
    name: a.name,
    avatar_url: avatarFile(slug, a) ? `/api/accounts/${encodeURIComponent(slug)}/avatar?v=${encodeURIComponent(a.connected_at)}` : null,
    connected_at: a.connected_at,
    last_ok_at: a.last_ok_at,
    error: a.error,
  };
}

const PENDING_COLOR = "#5f6873";

/** Every account: products, plus X logins still waiting for their website. */
export function productViews(now = new Date()): ProductView[] {
  const products = safeProducts();
  const known = new Set(products.map((p) => ("config" in p ? p.config.slug : p.slug)));
  const pending: ProductView[] = listXAccounts()
    .filter((a) => !known.has(a.product))
    .map((a) => {
      const x = xView(a.product, a);
      return { slug: a.product, name: a.name || a.handle, handle: x!.handle, timezone: "UTC", daily_cap: 0, today_count: 0, live: false, enabled: false, color: PENDING_COLOR, x, setup: "website", invalid: null };
    });
  const ready = products.map((p): ProductView => {
    if (!("config" in p)) {
      const x = xView(p.slug, getXAccount(p.slug));
      return { slug: p.slug, name: p.slug, handle: x?.handle ?? null, timezone: "UTC", daily_cap: 0, today_count: 0, live: false, enabled: false, color: PENDING_COLOR, x, setup: "ready", invalid: p.error };
    }
    const c = p.config;
    const today = dayRangeUtc(now, c.timezone);
    const x = xView(c.slug, p.xAccount);
    return {
      slug: c.slug,
      name: c.name,
      handle: x?.handle ?? (c.handle ? c.handle.replace(/^@/, "") : null),
      timezone: c.timezone,
      daily_cap: c.cadence.daily_cap,
      today_count: countPublishedBetween(today.start, today.end, c.slug),
      live: p.xAccount !== null,
      enabled: c.enabled,
      color: c.brand.colors.primary,
      x,
      setup: "ready",
      invalid: null,
    };
  });
  return [...ready, ...pending].sort((a, b) => a.name.localeCompare(b.name));
}

export function headerState(now = new Date()) {
  return { now: now.toISOString(), paused: pausedReason(), global_daily_cap: env.globalDailyCap, products: productViews(now) };
}
