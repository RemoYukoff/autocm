// Timezone helpers on top of Intl (no tz library). All instants are UTC Dates / ISO strings.

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of `date` in timezone `tz`. */
export function localParts(date: Date, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (e.g. -4h for New York in summer). */
function tzOffsetMs(ms: number, tz: string): number {
  const p = localParts(new Date(ms), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `tz`. Month is 1-12. Day/hour overflow is normalized. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - tzOffsetMs(guess, tz);
  // Re-apply once: the offset at the result can differ on DST-change days.
  const second = guess - tzOffsetMs(ms, tz);
  if (second !== ms) ms = second;
  return new Date(ms);
}

/** Local calendar date (Y-M-D) of `date` in `tz`, shifted by `addDays`. */
export function localDate(date: Date, tz: string, addDays = 0): { year: number; month: number; day: number } {
  const p = localParts(date, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** [start, end) of the local day containing `date` (+ addDays) in `tz`, as ISO UTC strings. */
export function dayRangeUtc(date: Date, tz: string, addDays = 0): { start: string; end: string; label: string } {
  const { year, month, day } = localDate(date, tz, addDays);
  const start = zonedToUtc(year, month, day, 0, 0, tz);
  const end = zonedToUtc(year, month, day + 1, 0, 0, tz);
  const label = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { start: start.toISOString(), end: end.toISOString(), label };
}
