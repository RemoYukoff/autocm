import { getFlag, logEvent, setFlag } from "../core/db/index.ts";

/** Flag key holding why an account's publishing is paused. Each account has its own switch. */
export const pauseKey = (product: string) => `paused:${product}`;

/** Stop publishing for one account. The reason is the flag's value. */
export function pause(product: string, reason = "manual"): void {
  setFlag(pauseKey(product), reason);
  logEvent("paused", { product, payload: { reason } });
}

export function resume(product: string): void {
  setFlag(pauseKey(product), null);
  logEvent("resumed", { product });
}

/** Why publishing is paused for this account, or null when it is not. */
export function pausedReason(product: string): string | null {
  return getFlag(pauseKey(product)) ?? null;
}
