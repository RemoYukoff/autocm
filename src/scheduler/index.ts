// Stream C (publish/ops). Signatures of planSlots / tick / runDaemon are frozen (contracts-v1).
import cron from "node-cron";
import { loadProducts } from "../core/config.ts";
import { env } from "../core/env.ts";
import { log } from "../core/log.ts";
import { pausedReason } from "../safety/pause.ts";
import { planProductSlots } from "./plan.ts";
import { currentTick, recover, tick as runTick } from "./tick.ts";

export { recover } from "./tick.ts";
export type { SlotRow, SlotStatus } from "./tick.ts";

/** Create slots for the next `days` days for every enabled product. Returns number created. */
export async function planSlots(days = 1): Promise<number> {
  const now = new Date();
  let created = 0;
  for (const product of loadProducts()) {
    if (!product.config.enabled) continue;
    created += planProductSlots(product, days, now);
  }
  return created;
}

/** One scheduler pass: generate posts for due slots, publish approved posts whose time has come. */
export async function tick(): Promise<void> {
  await runTick();
}

/** Long-running daemon: tick every 5 minutes, plan daily. */
export async function runDaemon(): Promise<void> {
  log.info({ paused: pausedReason() ?? "no" }, "autocm daemon starting");
  const rec = recover();
  if (rec.slots || rec.posts) log.warn(rec, "startup recovery");
  log.info({ created: await planSlots(2) }, "startup planning done");

  const safeTick = async () => {
    try {
      await runTick();
    } catch (e) {
      log.error({ err: (e as Error).message }, "tick failed");
    }
  };
  const safePlan = async () => {
    try {
      log.info({ created: await planSlots(2) }, "daily planning done");
    } catch (e) {
      log.error({ err: (e as Error).message }, "planning failed");
    }
  };

  const tickTask = cron.schedule("*/5 * * * *", safeTick, { name: "autocm-tick", timezone: "UTC", noOverlap: true });
  const planTask = cron.schedule("5 0 * * *", safePlan, { name: "autocm-plan", timezone: "UTC", noOverlap: true });
  await safeTick();

  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log.info({ signal }, "shutting down: waiting for the current tick to finish");
      void (async () => {
        await tickTask.stop();
        await planTask.stop();
        await currentTick()?.catch(() => undefined);
        await tickTask.destroy();
        await planTask.destroy();
        resolve();
      })();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
  log.info("autocm daemon stopped");
}
