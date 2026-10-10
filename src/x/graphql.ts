// Pure parsers for the JSON X's web client receives from its own GraphQL API. Matching is by shape, not by
// operation name, because the names are unverified (see selectors.ts). No I/O here: unit-tested directly.
import type { XMetrics, XProfile } from "../core/types.ts";
import { GQL_OPS, X_ERROR_CODES } from "./selectors.ts";

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

/** Depth-first walk over every object in a JSON tree, with the key it was found under. Stop when `visit` returns true. */
function walk(node: Json, visit: (o: Obj, key: string | null) => boolean | void, key: string | null = null, depth = 0): boolean {
  if (depth > 60) return false;
  if (Array.isArray(node)) {
    for (const v of node) if (walk(v, visit, key, depth + 1)) return true;
    return false;
  }
  if (!isObj(node)) return false;
  if (visit(node, key)) return true;
  for (const [k, v] of Object.entries(node)) if (isObj(v) && walk(v, visit, k, depth + 1)) return true;
  return false;
}

function find(node: Json, pred: (o: Obj, key: string | null) => boolean): Obj | null {
  let hit: Obj | null = null;
  walk(node, (o, k) => {
    if (pred(o, k)) {
      hit = o;
      return true;
    }
  });
  return hit;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
};

const firstNum = (o: Obj | undefined, keys: string[]): number | null => {
  if (!o) return null;
  for (const k of keys) {
    const n = num(o[k]);
    if (n !== null) return n;
  }
  return null;
};

/** Last path segment of a GraphQL URL, e.g. "CreateTweet". */
export function operationName(url: string): string {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop()?.replace(/\.json$/, "") ?? "";
  } catch {
    return "";
  }
}

// ---------- errors ----------

export interface XApiError {
  kind: "auth" | "rate_limit" | "permanent";
  message: string;
  codes: number[];
}

/** Classify the `errors` array of a GraphQL response, or null when there is none. */
export function classifyErrors(json: Json): XApiError | null {
  const errors = isObj(json) && Array.isArray(json.errors) ? (json.errors as unknown[]).filter(isObj) : [];
  if (!errors.length) return null;
  const codes = errors.map((e) => num(e.code) ?? num(isObj(e.extensions) ? e.extensions.code : undefined)).filter((c): c is number => c !== null);
  const text = errors.map((e) => String(e.message ?? "")).filter(Boolean).join("; ").slice(0, 300);
  const has = (list: readonly number[]) => codes.some((c) => list.includes(c));
  if (has(X_ERROR_CODES.auth)) return { kind: "auth", codes, message: `X refused the session (codes ${codes.join(",")}): ${text}` };
  if (has(X_ERROR_CODES.duplicate)) return { kind: "permanent", codes, message: `X rejected the post as a duplicate: ${text}` };
  if (has(X_ERROR_CODES.automated))
    return { kind: "permanent", codes, message: `X flagged the post as automated behavior and did not publish it: ${text}` };
  if (has(X_ERROR_CODES.rateLimit)) return { kind: "rate_limit", codes, message: `X rate limit / daily post limit (codes ${codes.join(",")}): ${text}` };
  return { kind: "permanent", codes, message: `X returned an error${codes.length ? ` (codes ${codes.join(",")})` : ""}: ${text || "unknown"}` };
}

// ---------- CreateTweet ----------

export type CreateTweetResult =
  | { ok: true; id: string; handle: string | null }
  | { ok: false; error: XApiError };

const POST_ONLY_CODES: readonly number[] = [...X_ERROR_CODES.duplicate, ...X_ERROR_CODES.automated, 185, 344];
const CREATE_KEY = /^(create_?tweet|createTweet|notetweet_create|create_note_tweet)$/i;

/**
 * Parse a response that may be the result of sending a post. Returns null when the JSON is not a CreateTweet
 * response at all (other GraphQL traffic on the page), so callers can keep waiting.
 */
export function parseCreateTweet(json: Json, url = "", method = "POST"): CreateTweetResult | null {
  const op = operationName(url);
  const byName = (GQL_OPS.createTweet as readonly string[]).includes(op);
  const data = isObj(json) && isObj(json.data) ? json.data : null;
  // find() returns the object *under* the matching key.
  const createNode = data ? find(data, (_o, k) => k !== null && CREATE_KEY.test(k)) : null;
  // Unknown operation name without a create_tweet key: still a post failure if a POST came back with an error
  // only posting produces (duplicate, automated, post limit).
  const err = classifyErrors(json);
  const postOnlyError = method === "POST" && err !== null && err.codes.some((c) => POST_ONLY_CODES.includes(c));
  if (!createNode && !byName && !postOnlyError) return null;

  const tweet = createNode ? find(createNode, (o) => typeof o.rest_id === "string" && /^\d+$/.test(o.rest_id)) : null;
  if (tweet) {
    const user = find(tweet, (o) => isObj(o.legacy) && typeof o.legacy.screen_name === "string") ?? find(tweet, (o) => isObj(o.core) && typeof o.core.screen_name === "string");
    const handle = user ? String((user.legacy as Obj | undefined)?.screen_name ?? (user.core as Obj | undefined)?.screen_name) : null;
    return { ok: true, id: tweet.rest_id as string, handle };
  }
  const error = err ?? {
    kind: "permanent" as const,
    codes: [],
    message: "X answered the post request without a post id (no error given): it was most likely not published",
  };
  return { ok: false, error };
}

// ---------- tweet metrics ----------

/** The tweet object with this rest_id, if present (unwraps TweetWithVisibilityResults via the walk). */
export function findTweet(json: Json, id: string): Obj | null {
  return find(json, (o) => o.rest_id === id && (isObj(o.legacy) || "views" in o || "favorite_count" in o));
}

export function metricsFromTweet(tweet: Obj): XMetrics {
  const legacy = isObj(tweet.legacy) ? tweet.legacy : tweet;
  const counts = isObj(tweet.counts) ? tweet.counts : undefined;
  const views = isObj(tweet.views) ? tweet.views : undefined;
  return {
    likes: firstNum(legacy, ["favorite_count", "like_count"]) ?? firstNum(counts, ["favorite_count", "like_count", "likes"]),
    reposts: firstNum(legacy, ["retweet_count", "repost_count"]) ?? firstNum(counts, ["retweet_count", "repost_count", "reposts"]),
    replies: firstNum(legacy, ["reply_count"]) ?? firstNum(counts, ["reply_count", "replies"]),
    quotes: firstNum(legacy, ["quote_count"]) ?? firstNum(counts, ["quote_count", "quotes"]),
    bookmarks: firstNum(legacy, ["bookmark_count"]) ?? firstNum(counts, ["bookmark_count", "bookmarks"]),
    views: firstNum(views, ["count"]) ?? firstNum(counts, ["view_count", "views"]),
  };
}

/** Metrics of tweet `id` from a TweetDetail-like response, or null if it is not in there. */
export function parseTweetMetrics(json: Json, id: string): XMetrics | null {
  const t = findTweet(json, id);
  if (!t) return null;
  const m = metricsFromTweet(t);
  return m.likes === null && m.reposts === null && m.replies === null && m.views === null ? null : m;
}

// ---------- users ----------

/** Bigger variant of an X avatar URL (…_normal.jpg -> …_400x400.jpg). */
export function largeAvatarUrl(url: string | null): string | null {
  return url ? url.replace(/_(normal|bigger|mini)(\.\w+)(\?.*)?$/, "_400x400$2") : null;
}

function userFrom(o: Obj): XProfile | null {
  const legacy = isObj(o.legacy) ? o.legacy : undefined;
  const core = isObj(o.core) ? o.core : undefined;
  const avatar = isObj(o.avatar) ? o.avatar : undefined;
  const handle = legacy?.screen_name ?? core?.screen_name;
  if (typeof handle !== "string" || !handle) return null;
  const name = core?.name ?? legacy?.name;
  const img = avatar?.image_url ?? legacy?.profile_image_url_https ?? legacy?.profile_image_url;
  return { handle, name: typeof name === "string" ? name : null, avatar_url: largeAvatarUrl(typeof img === "string" ? img : null) };
}

/** The user with this handle anywhere in the response (case-insensitive), or null. */
export function findUser(json: Json, handle: string): XProfile | null {
  const want = handle.replace(/^@/, "").toLowerCase();
  let hit: XProfile | null = null;
  walk(json, (o) => {
    const u = userFrom(o);
    if (u && u.handle.toLowerCase() === want) {
      hit = u;
      return true;
    }
  });
  return hit;
}

/** The logged-in user from a viewer-style response ({data:{viewer:{user_results:{result:{...}}}}}), or null. */
export function findViewer(json: Json): XProfile | null {
  const viewer = find(json, (_o, k) => k === "viewer" || k === "viewer_v2");
  if (!viewer) return null;
  let hit: XProfile | null = null;
  walk(viewer, (o) => {
    hit = userFrom(o);
    return hit !== null;
  });
  return hit;
}
