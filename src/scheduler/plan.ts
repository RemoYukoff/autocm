// Slot planning: a random number of posts per day at random times inside the product's posting windows
// (product timezone), spaced by min_gap_min. The next tick writes every pending slot, so the dashboard shows each
// post of the day long before it goes out.
import { getDb, logEvent } from "../core/db/index.ts";
import { log } from "../core/log.ts";
import type { Format, Product } from "../core/types.ts";
import { dayRangeUtc, localDate, zonedToUtc } from "../safety/time.ts";

const MIN = 60_000;
/** Never schedule a slot sooner than this from now (gives generation a chance to finish). */
export const MIN_SCHEDULE_LEAD_MIN = 15;
const SAMPLE_ATTEMPTS = 300;

interface Interval {
  start: number;
  end: number;
}

function parseWindow(w: string): { sh: number; sm: number; eh: number; em: number } {
  const [s, e] = w.split("-") as [string, string];
  const [sh, sm] = s.split(":").map(Number) as [number, number];
  const [eh, em] = e.split(":").map(Number) as [number, number];
  return { sh, sm, eh, em };
}

/** Posting windows of one local day as UTC intervals, clipped to `notBefore`, sorted, non-overlapping. */
export function windowIntervals(product: Product, now: Date, addDays: number, notBefore: number): Interval[] {
  const tz = product.config.timezone;
  const { year, month, day } = localDate(now, tz, addDays);
  const raw: Interval[] = [];
  for (const w of product.config.cadence.windows) {
    const { sh, sm, eh, em } = parseWindow(w);
    const crosses = eh * 60 + em <= sh * 60 + sm; // e.g. 22:00-01:00
    const start = zonedToUtc(year, month, day, sh, sm, tz).getTime();
    const end = zonedToUtc(year, month, day + (crosses ? 1 : 0), eh, em, tz).getTime();
    const s = Math.max(start, notBefore);
    if (end > s) raw.push({ start: s, end });
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

const floorMin = (t: number) => Math.floor(t / MIN) * MIN;

function gapsOk(times: number[], gapMs: number): boolean {
  for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! < gapMs) return false;
  return true;
}

/** Greedy earliest packing: the max number of times (<= n) that fit with the gap. */
function greedy(intervals: Interval[], n: number, gapMs: number): number[] {
  const out: number[] = [];
  let next = -Infinity;
  for (const iv of intervals) {
    let t = Math.ceil(Math.max(iv.start, next) / MIN) * MIN;
    while (t <= iv.end && out.length < n) {
      out.push(t);
      next = t + gapMs;
      t = Math.ceil(next / MIN) * MIN;
    }
  }
  return out;
}

/**
 * Pick up to `n` minute-aligned instants inside `intervals`, pairwise at least `gapMs` apart.
 * Random (rejection sampling); falls back to fewer slots, then to greedy packing.
 */
export function pickTimes(intervals: Interval[], n: number, gapMs: number, rand: () => number = Math.random): number[] {
  const total = intervals.reduce((s, iv) => s + (iv.end - iv.start), 0);
  if (n <= 0 || intervals.length === 0) return [];
  const at = (offset: number): number => {
    let o = offset;
    for (const iv of intervals) {
      const len = iv.end - iv.start;
      if (o <= len) return iv.start + o;
      o -= len;
    }
    return intervals[intervals.length - 1]!.end;
  };
  const fit = Math.min(n, greedy(intervals, n, gapMs).length);
  for (let k = fit; k >= 1; k--) {
    for (let a = 0; a < SAMPLE_ATTEMPTS; a++) {
      const times = Array.from({ length: k }, () => Math.ceil(at(rand() * total) / MIN) * MIN).sort((x, y) => x - y);
      const inside = times.every((t) => intervals.some((iv) => t >= iv.start && t <= iv.end));
      if (inside && gapsOk(times, gapMs)) return times;
    }
    if (k === fit) {
      const g = greedy(intervals, k, gapMs);
      if (g.length === k) return g.map(floorMin);
    }
  }
  return [];
}

/** How many posts one day gets: uniform in [posts_per_day_min, posts_per_day_max], never above daily_cap. */
export function dailyCount(cadence: Product["config"]["cadence"], rand: () => number = Math.random): number {
  const { posts_per_day_min: min, posts_per_day_max: max } = cadence;
  return Math.min(min + Math.floor(rand() * (max - min + 1)), cadence.daily_cap);
}

/** Slots that still count: planned, being written, written or published (not discarded or failed). */
const LIVE_SLOT = "status NOT IN ('skipped','failed')";

/** `intervals` minus the open ranges (t - gap, t + gap) around each of `times`. */
function carve(intervals: Interval[], times: number[], gapMs: number): Interval[] {
  let out = intervals;
  for (const t of times) {
    out = out.flatMap((iv) => {
      const pieces: Interval[] = [];
      if (iv.start <= t - gapMs) pieces.push({ start: iv.start, end: Math.min(iv.end, t - gapMs) });
      if (iv.end >= t + gapMs) pieces.push({ start: Math.max(iv.start, t + gapMs), end: iv.end });
      return pieces;
    });
  }
  return out;
}

/**
 * One more slot for the product, on demand, on local day `date` ("YYYY-MM-DD", today or later): a random time in that
 * day's windows at least min_gap_min from the account's other slots, while the day is under daily_cap.
 * Returns the new slot, or why it does not fit: the day is over, at daily_cap, or has no room left.
 */
export function addSlot(
  product: Product,
  format: Format | null,
  date: string,
  now = new Date(),
  rand: () => number = Math.random,
): { id: number; scheduled_at: string } | "past" | "cap" | "room" {
  const c = product.config;
  const gap = c.cadence.min_gap_min * MIN;
  const db = getDb();
  const [y, mo, day] = date.split("-").map(Number) as [number, number, number];
  const today = localDate(now, c.timezone);
  const d = Math.round((Date.UTC(y, mo - 1, day) - Date.UTC(today.year, today.month - 1, today.day)) / (24 * 60 * MIN));
  if (d < 0) return "past";
  const range = dayRangeUtc(now, c.timezone, d);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE product = ? AND ${LIVE_SLOT} AND scheduled_at >= ? AND scheduled_at < ?`).get(c.slug, range.start, range.end) as { n: number };
  if (Number(count.n) >= c.cadence.daily_cap) return "cap";
  const near = db
    .prepare(`SELECT scheduled_at FROM slots WHERE product = ? AND ${LIVE_SLOT} AND scheduled_at > ? AND scheduled_at < ?`)
    .all(c.slug, new Date(Date.parse(range.start) - gap).toISOString(), new Date(Date.parse(range.end) + gap).toISOString()) as { scheduled_at: string }[];
  const free = carve(windowIntervals(product, now, d, now.getTime() + MIN_SCHEDULE_LEAD_MIN * MIN), near.map((r) => Date.parse(r.scheduled_at)), gap);
  const [t] = pickTimes(free, 1, gap, rand);
  if (t === undefined) return "room";
  const scheduled = new Date(t).toISOString();
  const r = db.prepare("INSERT OR IGNORE INTO slots (product, scheduled_at, format) VALUES (?, ?, ?)").run(c.slug, scheduled, format);
  if (Number(r.changes) !== 1) return "room";
  const id = Number(r.lastInsertRowid);
  logEvent("slot_added", { product: c.slug, payload: { slot_id: id, scheduled_at: scheduled, format, source: "dashboard" } });
  log.info({ product: c.slug, slot: id, scheduled_at: scheduled }, "slot added from the dashboard");
  return { id, scheduled_at: scheduled };
}

/** Plan one product. Skips any local day that already has slots. Returns slots created. */
export function planProductSlots(product: Product, days: number, now = new Date(), rand: () => number = Math.random): number {
  const c = product.config;
  if (!c.enabled) return 0;
  const db = getDb();
  const insert = db.prepare("INSERT OR IGNORE INTO slots (product, scheduled_at) VALUES (?, ?)");
  let created = 0;
  for (let d = 0; d < days; d++) {
    const range = dayRangeUtc(now, c.timezone, d);
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM slots WHERE product = ? AND scheduled_at >= ? AND scheduled_at < ?")
      .get(c.slug, range.start, range.end) as { n: number };
    if (Number(existing.n) > 0) continue;
    const n = dailyCount(c.cadence, rand);
    if (n <= 0) continue;
    const intervals = windowIntervals(product, now, d, now.getTime() + MIN_SCHEDULE_LEAD_MIN * MIN);
    const times = pickTimes(intervals, n, c.cadence.min_gap_min * MIN, rand);
    const planned: string[] = [];
    for (const t of times) {
      const scheduled = new Date(t).toISOString();
      if (Number(insert.run(c.slug, scheduled).changes) === 1) {
        created++;
        planned.push(scheduled);
      }
    }
    if (planned.length) {
      logEvent("slots_planned", { product: c.slug, payload: { day: range.label, scheduled_at: planned } });
      log.info({ product: c.slug, day: range.label, slots: planned }, "slots planned");
    } else if (times.length < n) {
      log.debug({ product: c.slug, day: range.label }, "no room left in today's windows");
    }
  }
  return created;
}
