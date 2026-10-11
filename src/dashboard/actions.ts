// Write side of the dashboard: veto, add a slot, move a slot, pause/resume. Writing and publishing belong to the
// scheduler alone: "Generate" only adds a slot and asks the scheduler for a pass now.
// A veto is a conditional UPDATE (WHERE status = 'approved') so it can never stomp on the scheduler's tick,
// and a double click finds the post already rejected and is refused.
import { loadProduct } from "../core/config.ts";
import { getDb, getPost, logEvent, nowIso } from "../core/db/index.ts";
import { track } from "../core/inflight.ts";
import { log } from "../core/log.ts";
import type { PostRow } from "../core/types.ts";
import { isPaused, pause, resume } from "../safety/pause.ts";
import { zonedToUtc } from "../safety/time.ts";
import { tick, type SlotRow } from "../scheduler/index.ts";
import { addSlot } from "../scheduler/plan.ts";
import { currentTick } from "../scheduler/tick.ts";
import { getSlot, slotOfPost } from "./queries.ts";

export const VETO_ERROR = "vetoed in dashboard";

export class ActionError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: ActionError["status"], message: string) {
    super(message);
    this.name = "ActionError";
    this.status = status;
  }
}

// ---------- helpers ----------

function slotEvent(type: string, slot: SlotRow, payload: Record<string, unknown> = {}, postId?: number | null): void {
  logEvent(type, {
    product: slot.product,
    post_id: postId ?? slot.post_id ?? undefined,
    payload: { slot_id: slot.id, scheduled_at: slot.scheduled_at, source: "dashboard", ...payload },
  });
}

/** approved -> rejected, atomically. False when the post is no longer approved (e.g. the tick is publishing it). */
function vetoPost(post: PostRow, slotId: number | null): boolean {
  const r = getDb()
    .prepare("UPDATE posts SET status = 'rejected', error = ?, updated_at = ? WHERE id = ? AND status = 'approved'")
    .run(VETO_ERROR, nowIso(), post.id);
  if (Number(r.changes) !== 1) return false;
  logEvent("post_vetoed", { product: post.product, post_id: post.id, payload: { source: "dashboard", slot_id: slotId } });
  return true;
}

function requirePost(id: number): PostRow {
  const post = getPost(id);
  if (!post) throw new ActionError(404, `post #${id} not found`);
  return post;
}

function notApproved(post: PostRow, verb: string): ActionError {
  const now = getPost(post.id) ?? post;
  return new ActionError(409, `post #${post.id} is '${now.status}'; only approved posts can be ${verb}`);
}

// ---------- actions ----------

/** Veto an approved post. Its slot (if any) is marked skipped so the scheduler publishes nothing there. */
export function discardPost(postId: number): { post: PostRow; slot: SlotRow | null } {
  const post = requirePost(postId);
  const slot = slotOfPost(postId);
  if (!vetoPost(post, slot?.id ?? null)) throw notApproved(post, "discarded");
  if (slot) {
    const r = getDb().prepare("UPDATE slots SET status = 'skipped' WHERE id = ? AND post_id = ? AND status IN ('generated','pending')").run(slot.id, postId);
    if (Number(r.changes) === 1) slotEvent("slot_skipped", slot, { reason: VETO_ERROR }, postId);
  }
  return { post: getPost(postId)!, slot: slot ? (getSlot(slot.id) ?? null) : null };
}

/** A scheduler pass right after the one in flight (if any), so a new slot is written without waiting for the next one. */
function kickTick(): void {
  track((currentTick() ?? Promise.resolve()).then(() => tick())).catch((e: Error) => log.error({ err: e.message }, "tick from the dashboard failed"));
}

function readyProduct(slug: string) {
  try {
    return loadProduct(slug);
  } catch {
    throw new ActionError(409, `${slug} is not set up yet`);
  }
}

/** Add one post to the account: a new slot at a free time; the scheduler writes it right away. */
export function generateSlot(slug: string): SlotRow {
  const product = readyProduct(slug);
  const added = addSlot(product);
  if (!added) throw new ActionError(409, "no free time in the next 7 days (posting windows, daily cap and gap between posts are full)");
  kickTick();
  return getSlot(added.id)!;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MOVABLE = ["pending", "claimed", "generated"];

/** Move a slot that has not published yet. `local` is "YYYY-MM-DDTHH:MM" in the account's timezone. */
export function rescheduleSlot(id: number, local: unknown, now = new Date()): SlotRow {
  const slot = getSlot(id);
  if (!slot) throw new ActionError(404, `slot #${id} not found`);
  if (!MOVABLE.includes(slot.status)) throw new ActionError(409, `slot #${id} is '${slot.status}'; only posts not published yet can move`);
  const m = typeof local === "string" ? LOCAL_RE.exec(local) : null;
  if (!m) throw new ActionError(400, "time must look like 2026-10-11T14:30");
  const c = readyProduct(slot.product).config;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const at = zonedToUtc(y, mo, d, h, mi, c.timezone);
  if (at.getTime() < now.getTime() + 60_000) throw new ActionError(400, "pick a time in the future");
  const gap = c.cadence.min_gap_min * 60_000;
  const near = getDb()
    .prepare("SELECT scheduled_at FROM slots WHERE product = ? AND id != ? AND status NOT IN ('skipped','failed') AND scheduled_at > ? AND scheduled_at < ?")
    .get(slot.product, id, new Date(at.getTime() - gap).toISOString(), new Date(at.getTime() + gap).toISOString()) as { scheduled_at: string } | undefined;
  if (near) throw new ActionError(409, `too close to another post; keep ${c.cadence.min_gap_min} min between posts`);
  const scheduled = at.toISOString();
  const r = getDb()
    .prepare("UPDATE OR IGNORE slots SET scheduled_at = ? WHERE id = ? AND status IN ('pending','claimed','generated')")
    .run(scheduled, id);
  if (Number(r.changes) !== 1) throw new ActionError(409, `slot #${id} changed meanwhile; try again`);
  slotEvent("slot_moved", slot, { to: scheduled });
  return getSlot(id)!;
}

export function pausePublishing(product: string): boolean {
  pause(product);
  return isPaused(product);
}

export function resumePublishing(product: string): boolean {
  resume(product);
  return isPaused(product);
}
