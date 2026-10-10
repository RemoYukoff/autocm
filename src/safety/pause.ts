import fs from "node:fs";
import { getFlag, logEvent, setFlag } from "../core/db/index.ts";
import { env } from "../core/env.ts";
import { PAUSE_FILE } from "../core/paths.ts";

export function pause(reason = "manual"): void {
  setFlag("paused", "1");
  setFlag("paused_reason", reason);
  logEvent("paused", { payload: { reason } });
}

export function resume(): void {
  setFlag("paused", null);
  setFlag("paused_reason", null);
  if (fs.existsSync(PAUSE_FILE)) fs.rmSync(PAUSE_FILE);
  logEvent("resumed");
}

/** Why publishing is paused, or null when it is not. */
export function pausedReason(): string | null {
  if (env.paused) return "AUTOCM_PAUSED=1";
  if (fs.existsSync(PAUSE_FILE)) return `pause file ${PAUSE_FILE}`;
  if (getFlag("paused") === "1") return getFlag("paused_reason") ?? "paused";
  return null;
}
