import { getFlag, logEvent, setFlag } from "../core/db/index.ts";

/** Flag key set while an account's publishing is paused. Each account has its own switch. */
export const pauseKey = (product: string) => `paused:${product}`;

/** Stop publishing for one account. `cause` (auto-pauses only) goes to the event log, nowhere else. */
export function pause(product: string, cause?: string): void {
  setFlag(pauseKey(product), "1");
  logEvent("paused", { product, payload: cause ? { cause } : undefined });
}

export function resume(product: string): void {
  setFlag(pauseKey(product), null);
  logEvent("resumed", { product });
}

export function isPaused(product: string): boolean {
  return getFlag(pauseKey(product)) !== undefined;
}
