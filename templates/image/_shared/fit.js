// Text auto-fit, shared by every image template (and unit-tested from tests/media).
// The DOM side only supplies a `fits(scale)` predicate; the search itself is pure.

/**
 * Largest scale in [min, max] for which `fits(scale)` is true (binary search, monotonic predicate).
 * Returns { scale, ok }: ok=false means even `min` overflows and the caller must shrink further or report.
 */
export function fitScale(fits, { min = 0.4, max = 1, steps = 12 } = {}) {
  if (fits(max)) return { scale: max, ok: true };
  if (!fits(min)) return { scale: min, ok: false };
  let lo = min;
  let hi = max;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { scale: lo, ok: true };
}

/** True when an element's content spills out of its box (1px tolerance for subpixel rounding). */
export function overflows(el) {
  return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
}
