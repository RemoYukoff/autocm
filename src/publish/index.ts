// Stream C (publish/ops). Signatures of publishPost / xWhoami are frozen (contracts-v1).
import { getDb, getFlag, getPost, logEvent, markXAccount, nowIso, setFlag, updatePost } from "../core/db/index.ts";
import { track } from "../core/inflight.ts";
import { log } from "../core/log.ts";
import type { PostRow, Product, PublishResult, XProfile } from "../core/types.ts";
import { checkGuards } from "../safety/guards.ts";
import { pause } from "../safety/pause.ts";
import { textHash } from "../safety/text.ts";
import { postMediaFiles } from "./media.ts";
import { getXClient, mapXError, type XError } from "./x.ts";
// Side effect: registers the browser client (src/x/) as the default XClient. src/x imports only ./x.ts from here.
import "../x/index.ts";

export { XAuthError, XError } from "./x.ts";

/** Thrown when a guard blocks publishing. The post stays `approved` with `error` set; callers may retry later. */
export class GuardError extends Error {
  readonly reason: string;
  readonly postId: number;
  constructor(postId: number, reason: string) {
    super(`post #${postId} blocked by guard: ${reason}`);
    this.name = "GuardError";
    this.reason = reason;
    this.postId = postId;
  }
}

/** Thrown when the post is not in a publishable state (wrong status, stuck publishing, wrong product). */
export class PublishStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishStateError";
  }
}

export const FAILURES_FLAG = "consecutive_failures";
export const MAX_CONSECUTIVE_FAILURES = 3;

function recordFailure(product: string, err: XError): void {
  const n = Number(getFlag(FAILURES_FLAG) ?? 0) + 1;
  setFlag(FAILURES_FLAG, String(n));
  if (err.kind === "auth") {
    pause(`X auth error on ${product}: ${err.message}`);
    log.error({ product, err: err.message }, "auth error from X: publishing paused");
  } else if (n >= MAX_CONSECUTIVE_FAILURES) {
    pause(`${n} consecutive publish failures (last: ${err.message})`);
    log.error({ product, failures: n }, "too many consecutive publish failures: publishing paused");
  }
}

function markPublished(post: PostRow, tweet: { id: string; url: string }): PublishResult {
  updatePost(post.id, { status: "published", tweet_id: tweet.id, url: tweet.url, published_at: post.published_at ?? nowIso(), error: null });
  setFlag(FAILURES_FLAG, "0");
  logEvent("published", { product: post.product, post_id: post.id, payload: { tweet_id: tweet.id, url: tweet.url } });
  log.info({ product: post.product, post: post.id, url: tweet.url }, "published");
  return { tweet_id: tweet.id, url: tweet.url };
}

/** Run guards, then publish to X. Updates the post row. */
export async function publishPost(post: PostRow, product: Product): Promise<PublishResult> {
  const slug = product.config.slug;
  const current = getPost(post.id) ?? post; // always act on the DB state, not a possibly stale row
  const ctx = { product: slug, post_id: current.id };

  if (current.product !== slug) throw new PublishStateError(`post #${current.id} belongs to ${current.product}, not ${slug}`);

  // A previous live attempt got as far as 'publishing'. Never re-post blindly.
  if (current.status === "publishing") {
    if (current.tweet_id) {
      logEvent("publish_recovered", { ...ctx, payload: { tweet_id: current.tweet_id } });
      return markPublished(current, { id: current.tweet_id, url: current.url ?? `https://x.com/i/web/status/${current.tweet_id}` });
    }
    throw new PublishStateError(`post #${current.id} is stuck in 'publishing' without tweet_id; refusing to re-post (it may be live)`);
  }
  if (current.status !== "approved") {
    throw new PublishStateError(`post #${current.id} is '${current.status}'; only 'approved' posts can be published`);
  }

  const text = current.text ?? "";
  if (!current.text_hash && text) updatePost(current.id, { text_hash: textHash(text) });

  const guard = checkGuards(product, text);
  if (!guard.ok) {
    const reason = guard.reason ?? "blocked";
    updatePost(current.id, { error: `guard: ${reason}` });
    logEvent("publish_blocked", { ...ctx, payload: { reason } });
    log.warn({ ...ctx, reason }, "publish blocked by guard");
    throw new GuardError(current.id, reason);
  }

  const claim = getDb()
    .prepare("UPDATE posts SET status = 'publishing', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ? AND status = 'approved'")
    .run(nowIso(), current.id);
  if (Number(claim.changes) !== 1) throw new PublishStateError(`post #${current.id} was claimed by another publisher`);
  logEvent("publishing", ctx);

  let tweet: { id: string; url: string };
  try {
    // No retry: once Post is clicked the outcome can be ambiguous, and a duplicate post is worse than a missed one.
    tweet = await track(getXClient(product).post(text, postMediaFiles(current), current.alt_text));
  } catch (e) {
    const err = mapXError(e, "publish");
    updatePost(current.id, { status: "failed", error: err.message });
    logEvent("publish_failed", { ...ctx, payload: { kind: err.kind, message: err.message } });
    log.error({ ...ctx, kind: err.kind, err: err.message }, "publish failed");
    recordFailure(slug, err);
    if (err.kind === "auth") markXAccount(slug, { ok: false, error: err.message });
    throw err;
  }
  markXAccount(slug, { ok: true });
  // Outside the try: if this DB write fails the post stays 'publishing' without tweet_id and recovery marks it failed.
  return markPublished(getPost(current.id) ?? current, tweet);
}

/** CLI `x whoami`: read the profile of the product's logged-in X session. */
export async function xWhoami(product: Product): Promise<XProfile> {
  return track(getXClient(product).profile());
}
