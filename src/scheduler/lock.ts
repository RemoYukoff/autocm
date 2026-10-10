// Cross-process tick lock stored in flags: value = "<iso timestamp>|<owner token>". Stale after 20 min.
import crypto from "node:crypto";
import { getDb, nowIso } from "../core/db/index.ts";

export const TICK_LOCK_KEY = "tick_lock";
export const LOCK_STALE_MS = 20 * 60_000;

/** Take the lock atomically (synchronous). Returns the owner token, or null when another live holder has it. */
export function acquireTickLock(now = new Date()): string | null {
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const staleBefore = new Date(now.getTime() - LOCK_STALE_MS).toISOString();
  const res = getDb()
    .prepare(
      `INSERT INTO flags (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE flags.value < ?`,
    )
    .run(TICK_LOCK_KEY, `${now.toISOString()}|${token}`, staleBefore);
  return Number(res.changes) === 1 ? token : null;
}

const ownerClause = "key = ? AND substr(value, instr(value, '|') + 1) = ?";

/** Refresh the lock timestamp during long ticks. Returns false if the lock was lost. */
export function heartbeatTickLock(token: string): boolean {
  const res = getDb()
    .prepare(`UPDATE flags SET value = ? WHERE ${ownerClause}`)
    .run(`${nowIso()}|${token}`, TICK_LOCK_KEY, token);
  return Number(res.changes) === 1;
}

export function releaseTickLock(token: string): void {
  getDb().prepare(`DELETE FROM flags WHERE ${ownerClause}`).run(TICK_LOCK_KEY, token);
}
