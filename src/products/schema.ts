// Starting values for a new product's cadence (website drafts and tests).
import type { ProductConfig } from "../core/types.ts";

export function defaultCadence(): ProductConfig["cadence"] {
  return { posts_per_day_min: 1, posts_per_day_max: 2, windows: ["09:00-11:00", "13:00-16:00"], daily_cap: 3, min_gap_min: 90 };
}
