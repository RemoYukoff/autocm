// Write side of the dashboard: veto and pause/resume. Writing and publishing belong to the scheduler alone.
// A veto is a conditional UPDATE (WHERE status = 'approved') so it can never stomp on the scheduler's tick,
// and a double click finds the post already rejected and is refused.
import { getDb, getPost, logEvent, nowIso } from "../core/db/index.ts";
import type { PostRow } from "../core/types.ts";
import { pause, pausedReason, resume } from "../safety/pause.ts";
import type { SlotRow } from "../scheduler/index.ts";
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

export function pausePublishing(reason?: string): string | null {
  pause(reason?.trim() || "paused from dashboard");
  return pausedReason();
}

export function resumePublishing(): string | null {
  resume();
  return pausedReason();
}
