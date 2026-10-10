import { getFlag, logEvent, setFlag } from "../core/db/index.ts";

/** Stop all publishing. The reason is the flag's value. */
export function pause(reason = "manual"): void {
  setFlag("paused", reason);
  logEvent("paused", { payload: { reason } });
}

export function resume(): void {
  setFlag("paused", null);
  logEvent("resumed");
}

/** Why publishing is paused, or null when it is not. */
export function pausedReason(): string | null {
  return getFlag("paused") ?? null;
}
