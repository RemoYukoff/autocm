// One scheduler pass: recover stuck work, generate posts for due slots, publish posts whose time has come.
import { loadProduct } from "../core/config.ts";
import { getDb, getPost, logEvent, nowIso, updatePost } from "../core/db/index.ts";
import { log } from "../core/log.ts";
import type { PostRow } from "../core/types.ts";
import { generatePost } from "../pipeline.ts";
import { GuardError, publishPost } from "../publish/index.ts";
import { pausedReason } from "../safety/pause.ts";
import { acquireTickLock, heartbeatTickLock, releaseTickLock } from "./lock.ts";

export type SlotStatus = "pending" | "claimed" | "generated" | "done" | "skipped" | "failed";

export interface SlotRow {
  id: number;
  product: string;
  scheduled_at: string;
  generate_at: string;
  status: SlotStatus;
  post_id: number | null;
  claimed_at: string | null;
}

const MIN = 60_000;
export const STUCK_AFTER_MS = 30 * MIN;
export const OVERDUE_SKIP_MS = 3 * 60 * MIN;

const iso = (ms: number) => new Date(ms).toISOString();

function setSlot(id: number, status: SlotStatus, postId?: number | null): void {
  if (postId === undefined) getDb().prepare("UPDATE slots SET status = ? WHERE id = ?").run(status, id);
  else getDb().prepare("UPDATE slots SET status = ?, post_id = ? WHERE id = ?").run(status, postId, id);
}

function slotEvent(type: string, slot: SlotRow, payload: Record<string, unknown> = {}, postId?: number | null): void {
  logEvent(type, { product: slot.product, post_id: postId ?? slot.post_id ?? undefined, payload: { slot_id: slot.id, scheduled_at: slot.scheduled_at, ...payload } });
}

function postForSlot(slot: SlotRow): PostRow | undefined {
  if (slot.post_id) return getPost(slot.post_id);
  return getDb().prepare("SELECT * FROM posts WHERE slot_id = ? ORDER BY id DESC LIMIT 1").get(slot.id) as PostRow | undefined;
}

/** Recover work left behind by a crash or a hung stage. Never re-posts anything. */
export function recover(now = new Date()): { slots: number; posts: number } {
  const db = getDb();
  const staleBefore = iso(now.getTime() - STUCK_AFTER_MS);
  let slots = 0;
  let posts = 0;

  const stuckSlots = db.prepare("SELECT * FROM slots WHERE status = 'claimed' AND claimed_at < ?").all(staleBefore) as unknown as SlotRow[];
  for (const slot of stuckSlots) {
    const post = postForSlot(slot);
    if (post?.status === "approved") {
      // Generation finished but the slot was never updated (crash in between): keep the post.
      setSlot(slot.id, "generated", post.id);
      slotEvent("slot_recovered", slot, { to: "generated" }, post.id);
    } else {
      if (post && (post.status === "generating" || post.status === "planned")) {
        updatePost(post.id, { status: "failed", error: "generation stalled > 30 min (recovered by scheduler)" });
      }
      setSlot(slot.id, "failed", post?.id ?? null);
      slotEvent("slot_recovered", slot, { to: "failed", post_status: post?.status ?? null }, post?.id);
    }
    slots++;
  }

  const stuckPosts = db.prepare("SELECT * FROM posts WHERE status = 'publishing' AND updated_at < ?").all(staleBefore) as unknown as PostRow[];
  for (const post of stuckPosts) {
    if (post.tweet_id) {
      updatePost(post.id, { status: "published", published_at: post.published_at ?? post.updated_at, error: null });
      logEvent("publish_recovered", { product: post.product, post_id: post.id, payload: { tweet_id: post.tweet_id } });
    } else {
      updatePost(post.id, {
        status: "failed",
        error: "stuck in 'publishing' > 30 min without tweet_id; not re-posted (check the X account manually)",
      });
      logEvent("publish_stuck", { product: post.product, post_id: post.id });
      log.error({ product: post.product, post: post.id }, "post stuck in publishing marked failed; it may or may not be live");
    }
    posts++;
  }
  return { slots, posts };
}

/** Claim and generate due slots, one at a time. */
async function generateDue(token: string): Promise<void> {
  const db = getDb();
  const due = db
    .prepare("SELECT * FROM slots WHERE status = 'pending' AND generate_at <= ? ORDER BY generate_at")
    .all(nowIso()) as unknown as SlotRow[];
  if (!due.length) return;

  const paused = pausedReason();
  if (paused) {
    // Do not burn LLM quota while publishing is stopped; slots are skipped once they go 3 h overdue.
    log.info({ paused, due: due.length }, "paused: not generating due slots");
  }

  for (const slot of due) {
    const now = Date.now();
    if (Date.parse(slot.scheduled_at) < now - OVERDUE_SKIP_MS) {
      const r = db.prepare("UPDATE slots SET status = 'skipped' WHERE id = ? AND status = 'pending'").run(slot.id);
      if (Number(r.changes) === 1) slotEvent("slot_skipped", slot, { reason: "overdue > 3h before generation" });
      continue;
    }
    if (paused) continue;

    let enabled = true;
    try {
      enabled = loadProduct(slot.product).config.enabled;
    } catch (e) {
      setSlot(slot.id, "failed");
      slotEvent("slot_failed", slot, { reason: `product load failed: ${(e as Error).message}` });
      continue;
    }
    if (!enabled) {
      setSlot(slot.id, "skipped");
      slotEvent("slot_skipped", slot, { reason: "product disabled" });
      continue;
    }

    const claim = db.prepare("UPDATE slots SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), slot.id);
    if (Number(claim.changes) !== 1) continue; // someone else got it
    heartbeatTickLock(token);
    slotEvent("slot_claimed", slot);

    try {
      const post = await generatePost(slot.product, { slotId: slot.id });
      if (post.slot_id == null) updatePost(post.id, { slot_id: slot.id });
      if (post.status === "approved") {
        setSlot(slot.id, "generated", post.id);
        slotEvent("slot_generated", slot, {}, post.id);
      } else {
        setSlot(slot.id, "failed", post.id);
        slotEvent("slot_failed", slot, { reason: `generation ended '${post.status}'` }, post.id);
      }
    } catch (e) {
      const post = postForSlot(slot);
      if (post && (post.status === "generating" || post.status === "planned")) {
        updatePost(post.id, { status: "failed", error: `generation error: ${(e as Error).message}` });
      }
      setSlot(slot.id, "failed", post?.id ?? null);
      slotEvent("slot_failed", slot, { reason: `generation error: ${(e as Error).message}` }, post?.id);
      log.error({ product: slot.product, slot: slot.id, err: (e as Error).message }, "generation failed");
    }
    heartbeatTickLock(token);
  }
}

/** Publish approved posts whose slot time has come; skip slots more than 3 h late. */
async function publishDue(token: string): Promise<void> {
  const db = getDb();
  const due = db
    .prepare("SELECT * FROM slots WHERE status = 'generated' AND scheduled_at <= ? ORDER BY scheduled_at")
    .all(nowIso()) as unknown as SlotRow[];

  for (const slot of due) {
    const post = slot.post_id ? getPost(slot.post_id) : undefined;
    if (!post) {
      setSlot(slot.id, "failed");
      slotEvent("slot_failed", slot, { reason: "slot has no post" });
      continue;
    }
    if (post.status === "published" || post.status === "dry_run") {
      setSlot(slot.id, "done");
      continue;
    }
    if (post.status === "publishing") continue; // in flight elsewhere, or recovery will resolve it
    if (post.status !== "approved") {
      setSlot(slot.id, "failed");
      slotEvent("slot_failed", slot, { reason: `post is '${post.status}'` }, post.id);
      continue;
    }
    if (Date.parse(slot.scheduled_at) < Date.now() - OVERDUE_SKIP_MS) {
      setSlot(slot.id, "skipped");
      updatePost(post.id, { error: "slot skipped: more than 3 h overdue" });
      slotEvent("slot_skipped", slot, { reason: "overdue > 3h" }, post.id);
      continue;
    }

    try {
      const product = loadProduct(slot.product);
      const res = await publishPost(post, product);
      setSlot(slot.id, "done");
      slotEvent("slot_done", slot, { mode: res.mode, url: res.url, preview_path: res.preview_path }, post.id);
    } catch (e) {
      if (e instanceof GuardError) {
        // Paused, cap, min gap, duplicate: leave the slot 'generated' and try again next tick until 3 h overdue.
        log.info({ product: slot.product, slot: slot.id, reason: e.reason }, "publish deferred by guard");
      } else {
        setSlot(slot.id, "failed");
        slotEvent("slot_failed", slot, { reason: `publish error: ${(e as Error).message}` }, post.id);
        log.error({ product: slot.product, slot: slot.id, err: (e as Error).message }, "publish failed");
      }
    }
    heartbeatTickLock(token);
  }
}

let running: Promise<void> | null = null;

/** Promise of the tick in flight (if any), for graceful shutdown. */
export function currentTick(): Promise<void> | null {
  return running;
}

/** One scheduler pass, at most one at a time per process (in-memory) and across processes (tick_lock row). */
export function tick(): Promise<void> {
  if (running) {
    log.debug("tick already running in this process; skipping");
    return Promise.resolve();
  }
  // Synchronous: taken before any await so concurrent calls cannot both get through.
  const token = acquireTickLock();
  if (!token) {
    log.warn("tick lock held by another process; skipping");
    return Promise.resolve();
  }
  const run = (async () => {
    try {
      await Promise.resolve(); // yield first so `running` is set before any synchronous throw reaches finally
      const rec = recover();
      if (rec.slots || rec.posts) log.warn(rec, "recovered stuck slots/posts");
      await generateDue(token);
      await publishDue(token);
    } finally {
      releaseTickLock(token);
      running = null;
    }
  })();
  running = run;
  return run;
}
