// Read side of the dashboard: slots, posts and accounts shaped for the UI.
import path from "node:path";
import { listProductSlugs, loadProduct, loadProducts } from "../core/config.ts";
import { getDb, getXAccount, listXAccounts } from "../core/db/index.ts";
import { OUT_DIR } from "../core/paths.ts";
import type { MediaResult, PostRow, PostStatus, Product, XAccount } from "../core/types.ts";
import type { SlotRow } from "../scheduler/index.ts";
import { isPaused } from "../safety/pause.ts";
import { localDate, zonedToUtc } from "../safety/time.ts";
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
  text: string | null;
  alt_text: string | null;
  media: MediaView[];
  /** What the marketer meant the post to do. */
  goal: PostRow["goal"];
  play: PostRow["play"];
  angle: string | null;
  /** Engagement read back from X, once read. */
  metrics: Pick<PostRow, "views" | "likes" | "replies" | "reposts" | "quotes" | "bookmarks"> | null;
  /** Link to the tweet once published. */
  url: string | null;
  published_at: string | null;
  error: string | null;
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
  /** @handle of the connected X account, shown on previews. */
  handle: string | null;
  timezone: string;
  live: boolean;
  enabled: boolean;
  color: string;
  x: XAccountView | null;
  /** This account's publishing is paused. */
  paused: boolean;
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
  const metrics = p.metrics_at ? { views: p.views, likes: p.likes, replies: p.replies, reposts: p.reposts, quotes: p.quotes, bookmarks: p.bookmarks } : null;
  return {
    id: p.id,
    product: p.product,
    slot_id: p.slot_id,
    status: p.status,
    text: p.text,
    alt_text: p.alt_text,
    media: files,
    goal: p.goal,
    play: p.play,
    angle: p.angle,
    metrics,
    url: p.url,
    published_at: p.published_at,
    error: p.error,
  };
}

export function getSlot(id: number): SlotRow | undefined {
  return getDb().prepare("SELECT * FROM slots WHERE id = ?").get(id) as SlotRow | undefined;
}

/** The slot a post is attached to (slot.post_id = post), if any. */
export function slotOfPost(postId: number): SlotRow | undefined {
  return getDb().prepare("SELECT * FROM slots WHERE post_id = ? ORDER BY id DESC LIMIT 1").get(postId) as SlotRow | undefined;
}

/** The post a slot shows: its linked post, or the newest post generated for it (while generating, or one that failed). */
function slotPost(slot: SlotRow): PostRow | undefined {
  const db = getDb();
  if (slot.post_id) return db.prepare("SELECT * FROM posts WHERE id = ?").get(slot.post_id) as PostRow | undefined;
  if (slot.status !== "pending") {
    return db.prepare("SELECT * FROM posts WHERE slot_id = ? ORDER BY id DESC LIMIT 1").get(slot.id) as PostRow | undefined;
  }
  return undefined;
}

function slotView(s: SlotRow): SlotView {
  const p = slotPost(s);
  return { id: s.id, product: s.product, scheduled_at: s.scheduled_at, status: s.status, claimed_at: s.claimed_at, post: p ? postView(p) : null };
}

export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DayView {
  /** YYYY-MM-DD in the account's timezone. */
  date: string;
  published: number;
  /** Slots of that day the bot will still act on. */
  upcoming: number;
  /** Skipped (missed, account disabled) or failed. */
  dropped: number;
}

/** YYYY-MM-DD of `date` in `tz`. */
export function localYmd(date: Date, tz: string): string {
  const d = localDate(date, tz);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

const UPCOMING = new Set<SlotRow["status"]>(["pending", "claimed", "generated"]);

/** Every local day that has a slot, newest first, with what happened on it. Feeds the day strip and the calendar. */
export function postDays(product: string, tz: string): DayView[] {
  const rows = getDb()
    .prepare("SELECT scheduled_at, status FROM slots WHERE product = ? ORDER BY scheduled_at DESC")
    .all(product) as { scheduled_at: string; status: SlotRow["status"] }[];
  const days = new Map<string, DayView>();
  for (const r of rows) {
    const date = localYmd(new Date(r.scheduled_at), tz);
    let day = days.get(date);
    if (!day) days.set(date, (day = { date, published: 0, upcoming: 0, dropped: 0 }));
    if (r.status === "done") day.published++;
    else if (UPCOMING.has(r.status)) day.upcoming++;
    else day.dropped++;
  }
  return [...days.values()];
}

/** Posts being written right now (any day). */
export function writingCount(product?: string): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM slots WHERE status = 'claimed' AND (? IS NULL OR product = ?)").get(product ?? null, product ?? null) as { n: number };
  return Number(r.n);
}

/** Every slot of one local day (`YYYY-MM-DD` in `tz`), in every status, by time. */
export function daySlots(product: string, date: string, tz: string): SlotView[] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`bad date "${date}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = zonedToUtc(y, mo, d, 0, 0, tz).toISOString();
  const end = zonedToUtc(y, mo, d + 1, 0, 0, tz).toISOString();
  const rows = getDb()
    .prepare("SELECT * FROM slots WHERE product = ? AND scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at")
    .all(product, start, end) as unknown as SlotRow[];
  return rows.map(slotView);
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
export function productViews(): ProductView[] {
  const products = safeProducts();
  const known = new Set(products.map((p) => ("config" in p ? p.config.slug : p.slug)));
  const pending: ProductView[] = listXAccounts()
    .filter((a) => !known.has(a.product))
    .map((a) => {
      const x = xView(a.product, a);
      return { slug: a.product, name: a.name || a.handle, handle: x!.handle, timezone: "UTC", live: false, enabled: false, color: PENDING_COLOR, x, paused: isPaused(a.product), setup: "website", invalid: null };
    });
  const ready = products.map((p): ProductView => {
    if (!("config" in p)) {
      const x = xView(p.slug, getXAccount(p.slug));
      return { slug: p.slug, name: p.slug, handle: x?.handle ?? null, timezone: "UTC", live: false, enabled: false, color: PENDING_COLOR, x, paused: isPaused(p.slug), setup: "ready", invalid: p.error };
    }
    const c = p.config;
    const x = xView(c.slug, p.xAccount);
    return {
      slug: c.slug,
      name: c.name,
      handle: x?.handle ?? null,
      timezone: c.timezone,
      live: p.xAccount !== null,
      enabled: c.enabled,
      color: c.brand.colors.primary,
      x,
      paused: isPaused(c.slug),
      setup: "ready",
      invalid: null,
    };
  });
  return [...ready, ...pending].sort((a, b) => a.name.localeCompare(b.name));
}

export function headerState(now = new Date()) {
  return { now: now.toISOString(), products: productViews() };
}
