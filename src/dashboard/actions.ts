// Write side of the dashboard: veto, regenerate, publish now, generate, pause/resume.
// Every state change is a conditional UPDATE (WHERE status = ...) so it can never stomp on the scheduler's tick,
// and every action takes an in-process lock per post/slot so double clicks are refused instead of run twice.
import { loadProduct } from "../core/config.ts";
import { getDb, getPost, logEvent, nowIso, updatePost } from "../core/db/index.ts";
import { log } from "../core/log.ts";
import type { Format, PostRow, PublishResult } from "../core/types.ts";
import { generatePost } from "../pipeline.ts";
import { GuardError, PublishStateError, publishPost } from "../publish/index.ts";
import { pause, pausedReason, resume } from "../safety/pause.ts";
import type { SlotRow, SlotStatus } from "../scheduler/index.ts";
import { getSlot, slotOfPost } from "./queries.ts";

export const VETO_ERROR = "vetoed in dashboard";

export class ActionError extends Error {
  readonly status: 400 | 404 | 409 | 502;
  readonly guard?: string;
  constructor(status: ActionError["status"], message: string, guard?: string) {
    super(message);
    this.name = "ActionError";
    this.status = status;
    this.guard = guard;
  }
}

// ---------- in-process locks ----------

const held = new Set<string>();

/** Take all keys or none (synchronous, so two requests cannot both get through). */
function lock(keys: string[]): () => void {
  const busy = keys.find((k) => held.has(k));
  if (busy) throw new ActionError(409, `another action is already running on ${busy.replace(":", " #")}`);
  for (const k of keys) held.add(k);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const k of keys) held.delete(k);
  };
}

export function lockedKeys(): string[] {
  return [...held];
}

// ---------- background jobs ----------

export interface Job {
  id: number;
  kind: "regenerate" | "generate";
  product: string;
  slot_id: number | null;
  format: Format | null;
  status: "running" | "done" | "failed";
  post_id: number | null;
  post_status: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const jobs = new Map<number, { job: Job; done: Promise<void> }>();
let nextJobId = 1;
const KEEP_FINISHED_JOBS = 20;

function startJob(meta: Pick<Job, "kind" | "product" | "slot_id" | "format">, run: (job: Job) => Promise<PostRow>, release: () => void): Job {
  const job: Job = { id: nextJobId++, ...meta, status: "running", post_id: null, post_status: null, error: null, started_at: nowIso(), finished_at: null };
  const done = (async () => {
    try {
      const post = await run(job);
      job.post_id = post.id;
      job.post_status = post.status;
      job.status = post.status === "approved" ? "done" : "failed";
      if (post.status !== "approved") job.error = post.error ?? `generation ended '${post.status}'`;
    } catch (e) {
      job.status = "failed";
      job.error = (e as Error).message;
      log.error({ job: job.id, err: job.error }, "dashboard job failed");
    } finally {
      job.finished_at = nowIso();
      release();
      pruneJobs();
    }
  })();
  jobs.set(job.id, { job, done });
  return job;
}

function pruneJobs(): void {
  const finished = [...jobs.values()].filter((j) => j.job.status !== "running").sort((a, b) => b.job.id - a.job.id);
  for (const j of finished.slice(KEEP_FINISHED_JOBS)) jobs.delete(j.job.id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].map((j) => j.job).sort((a, b) => b.id - a.id);
}

/** Tests / shutdown: wait for every background job started so far. */
export async function settleJobs(): Promise<void> {
  await Promise.all([...jobs.values()].map((j) => j.done));
}

/** Tests: forget all jobs and locks. */
export function resetDashboardState(): void {
  jobs.clear();
  held.clear();
  nextJobId = 1;
}

// ---------- slot helpers (mirror src/scheduler/tick.ts) ----------

function setSlot(id: number, status: SlotStatus, postId?: number | null): void {
  if (postId === undefined) getDb().prepare("UPDATE slots SET status = ? WHERE id = ?").run(status, id);
  else getDb().prepare("UPDATE slots SET status = ?, post_id = ? WHERE id = ?").run(status, postId, id);
}

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

function requireSlot(id: number): SlotRow {
  const slot = getSlot(id);
  if (!slot) throw new ActionError(404, `slot #${id} not found`);
  return slot;
}

function notApproved(post: PostRow, verb: string): ActionError {
  const now = getPost(post.id) ?? post;
  return new ActionError(409, `post #${post.id} is '${now.status}'; only approved posts can be ${verb}`);
}

// ---------- actions ----------

/** Veto an approved post. Its slot (if any) is marked skipped so the scheduler publishes nothing there. */
export function discardPost(postId: number): { post: PostRow; slot: SlotRow | null } {
  const slot0 = slotOfPost(postId);
  const release = lock([`post:${postId}`, ...(slot0 ? [`slot:${slot0.id}`] : [])]);
  try {
    const post = requirePost(postId);
    if (!vetoPost(post, slot0?.id ?? null)) throw notApproved(post, "discarded");
    const slot = slotOfPost(postId);
    if (slot) {
      const r = getDb().prepare("UPDATE slots SET status = 'skipped' WHERE id = ? AND post_id = ? AND status IN ('generated','pending')").run(slot.id, postId);
      if (Number(r.changes) === 1) slotEvent("slot_skipped", slot, { reason: VETO_ERROR }, postId);
    }
    return { post: getPost(postId)!, slot: slot ? (getSlot(slot.id) ?? null) : null };
  } finally {
    release();
  }
}

/** Skip a slot that has not been generated yet. */
export function skipSlot(slotId: number): SlotRow {
  const release = lock([`slot:${slotId}`]);
  try {
    const slot = requireSlot(slotId);
    const r = getDb().prepare("UPDATE slots SET status = 'skipped' WHERE id = ? AND status = 'pending'").run(slotId);
    if (Number(r.changes) !== 1) throw new ActionError(409, `slot #${slotId} is '${getSlot(slotId)?.status}'; only pending slots can be skipped`);
    slotEvent("slot_skipped", slot, { reason: "skipped in dashboard" });
    return getSlot(slotId)!;
  } finally {
    release();
  }
}

/**
 * Veto the slot's current post (if approved) and generate a new one for the same slot in the background.
 * The slot is claimed exactly like the scheduler claims it, so tick neither generates nor publishes it meanwhile,
 * and when generation ends the slot becomes 'generated' (tick publishes it at scheduled_at) or 'failed'.
 */
export function regenerateSlot(slotId: number, format?: Format): Job {
  const slot = requireSlot(slotId);
  const keys = [`slot:${slotId}`, ...(slot.post_id ? [`post:${slot.post_id}`] : [])];
  const release = lock(keys);
  try {
    if (slot.status === "claimed") throw new ActionError(409, `slot #${slotId} is already generating`);
    if (slot.status === "done") throw new ActionError(409, `slot #${slotId} already published`);
    const old = slot.post_id ? getPost(slot.post_id) : undefined;
    if (old && ["publishing", "published"].includes(old.status)) {
      throw new ActionError(409, `post #${old.id} is '${old.status}'; too late to regenerate`);
    }

    // Optimistic claim: only if nobody changed the slot since we read it.
    const claim = getDb()
      .prepare("UPDATE slots SET status = 'claimed', claimed_at = ?, post_id = NULL WHERE id = ? AND status = ? AND post_id IS ?")
      .run(nowIso(), slotId, slot.status, slot.post_id);
    if (Number(claim.changes) !== 1) throw new ActionError(409, `slot #${slotId} changed meanwhile; refresh and retry`);

    if (old && old.status === "approved" && !vetoPost(old, slotId)) {
      // The tick got to it first (it is publishing it now): put the slot back as it was.
      getDb().prepare("UPDATE slots SET status = ?, post_id = ?, claimed_at = ? WHERE id = ? AND status = 'claimed'").run(slot.status, slot.post_id, slot.claimed_at, slotId);
      throw notApproved(old, "regenerated");
    }
    slotEvent("slot_claimed", slot, { reason: "regenerate", replaced_post: old?.id ?? null }, old?.id);
  } catch (e) {
    release();
    throw e;
  }

  return startJob(
    { kind: "regenerate", product: slot.product, slot_id: slotId, format: format ?? null },
    async () => {
      try {
        const post = await generatePost(slot.product, { slotId, format });
        if (post.slot_id == null) updatePost(post.id, { slot_id: slotId });
        if (post.status === "approved") {
          setSlot(slotId, "generated", post.id);
          slotEvent("slot_generated", slot, {}, post.id);
        } else {
          setSlot(slotId, "failed", post.id);
          slotEvent("slot_failed", slot, { reason: `generation ended '${post.status}'` }, post.id);
        }
        return getPost(post.id)!;
      } catch (e) {
        const post = getDb().prepare("SELECT * FROM posts WHERE slot_id = ? ORDER BY id DESC LIMIT 1").get(slotId) as PostRow | undefined;
        if (post && (post.status === "generating" || post.status === "planned")) {
          updatePost(post.id, { status: "failed", error: `generation error: ${(e as Error).message}` });
        }
        setSlot(slotId, "failed", post?.id ?? null);
        slotEvent("slot_failed", slot, { reason: `generation error: ${(e as Error).message}` }, post?.id);
        throw e;
      }
    },
    release,
  );
}

/** Generate an unscheduled post now (it shows up under Ready). */
export function generateNow(productSlug: string, format?: Format): Job {
  try {
    loadProduct(productSlug);
  } catch (e) {
    throw new ActionError(404, (e as Error).message.split("\n")[0]!);
  }
  const release = lock([`generate:${productSlug}`]);
  logEvent("dashboard_generate", { product: productSlug, payload: { format: format ?? "auto" } });
  return startJob({ kind: "generate", product: productSlug, slot_id: null, format: format ?? null }, () => generatePost(productSlug, { format }), release);
}

/**
 * Publish an approved post now. publishPost re-reads the row and only proceeds from 'approved' (atomic claim in
 * live mode), so it can never double-post with the tick. The slot is marked done exactly like the scheduler does.
 */
export async function publishNow(postId: number): Promise<{ post: PostRow; result: PublishResult }> {
  const slot0 = slotOfPost(postId);
  const release = lock([`post:${postId}`, ...(slot0 ? [`slot:${slot0.id}`] : [])]);
  try {
    const post = requirePost(postId);
    if (post.status === "publishing") throw new ActionError(409, `post #${postId} is already being published`);
    if (post.status !== "approved") throw notApproved(post, "published");
    let product;
    try {
      product = loadProduct(post.product);
    } catch (e) {
      throw new ActionError(400, (e as Error).message.split("\n")[0]!);
    }
    let result: PublishResult;
    try {
      result = await publishPost(post, product);
    } catch (e) {
      if (e instanceof GuardError) throw new ActionError(409, `blocked: ${e.reason}`, e.reason);
      if (e instanceof PublishStateError) throw new ActionError(409, e.message);
      const slot = slotOfPost(postId);
      if (slot && slot.status === "generated") {
        setSlot(slot.id, "failed");
        slotEvent("slot_failed", slot, { reason: `publish error: ${(e as Error).message}` }, postId);
      }
      throw new ActionError(502, `publish failed: ${(e as Error).message}`);
    }
    logEvent("dashboard_publish", { product: post.product, post_id: postId, payload: { url: result.url } });
    const slot = slotOfPost(postId);
    if (slot && slot.status !== "done") {
      setSlot(slot.id, "done");
      slotEvent("slot_done", slot, { url: result.url }, postId);
    }
    return { post: getPost(postId)!, result };
  } finally {
    release();
  }
}

export function pausePublishing(reason?: string): string | null {
  pause(reason?.trim() || "paused from dashboard");
  return pausedReason();
}

/** Clears the DB flag and the pause file; AUTOCM_PAUSED=1 in the environment still wins. */
export function resumePublishing(): string | null {
  resume();
  return pausedReason();
}
