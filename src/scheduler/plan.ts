// Slot planning: random times inside the product's posting windows (product timezone), spaced by min_gap_min.
import { getDb, logEvent } from "../core/db/index.ts";
import { log } from "../core/log.ts";
import type { Product } from "../core/types.ts";
import { dayRangeUtc, localDate, zonedToUtc } from "../safety/time.ts";

const MIN = 60_000;
/** generate_at = scheduled_at - GENERATE_LEAD */
/** Fallback when a product does not set cadence.generate_lead_min. */
export const GENERATE_LEAD_MIN = 180;
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

/** Plan one product. Skips any local day that already has slots. Returns slots created. */
export function planProductSlots(product: Product, days: number, now = new Date(), rand: () => number = Math.random): number {
  const c = product.config;
  if (!c.enabled) return 0;
  const n = Math.min(c.cadence.posts_per_day, c.cadence.daily_cap);
  const db = getDb();
  const insert = db.prepare("INSERT OR IGNORE INTO slots (product, scheduled_at, generate_at) VALUES (?, ?, ?)");
  let created = 0;
  for (let d = 0; d < days; d++) {
    const range = dayRangeUtc(now, c.timezone, d);
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM slots WHERE product = ? AND scheduled_at >= ? AND scheduled_at < ?")
      .get(c.slug, range.start, range.end) as { n: number };
    if (Number(existing.n) > 0) continue;
    if (n <= 0) continue;
    const intervals = windowIntervals(product, now, d, now.getTime() + MIN_SCHEDULE_LEAD_MIN * MIN);
    const times = pickTimes(intervals, n, c.cadence.min_gap_min * MIN, rand);
    const planned: string[] = [];
    for (const t of times) {
      const scheduled = new Date(t).toISOString();
      const generate = new Date(t - (c.cadence.generate_lead_min ?? GENERATE_LEAD_MIN) * MIN).toISOString();
      if (Number(insert.run(c.slug, scheduled, generate).changes) === 1) {
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
