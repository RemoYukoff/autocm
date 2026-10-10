// X (Twitter) client wrapper: OAuth 1.0a user context, v2 media upload + v2 tweets.
// Never call this in tests without injecting a fake `XApi` (see createXClient / setXClientFactory).
import fs from "node:fs";
import { ApiPartialResponseError, ApiRequestError, ApiResponseError, TwitterApi } from "twitter-api-v2";
import { log } from "../core/log.ts";
import type { MediaFile, Product, XCreds } from "../core/types.ts";

/** The subset of twitter-api-v2's v2 read/write client we use. Tests pass a fake. */
export type XApi = Pick<TwitterApi["v2"], "uploadMedia" | "createMediaMetadata" | "tweet" | "me" | "get">;

export type XErrorKind = "auth" | "rate_limit" | "transient" | "permanent";

export class XError extends Error {
  readonly kind: XErrorKind;
  readonly status?: number;
  constructor(message: string, kind: XErrorKind, status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "XError";
    this.kind = kind;
    this.status = status;
  }
}

/** 401/403 from X: bad/expired/revoked creds or missing write permission. Publisher pauses on this. */
export class XAuthError extends XError {
  constructor(message: string, status?: number, cause?: unknown) {
    super(message, "auth", status, cause);
    this.name = "XAuthError";
  }
}

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
const PROCESSING_TIMEOUT_MS = 15 * 60_000;
const ALT_TEXT_MAX = 1000;

const MIME_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg" };
const ALLOWED: Record<string, { category: "tweet_image" | "tweet_video"; max: number }> = {
  "image/png": { category: "tweet_image", max: IMAGE_MAX_BYTES },
  "image/jpeg": { category: "tweet_image", max: IMAGE_MAX_BYTES },
  "video/mp4": { category: "tweet_video", max: VIDEO_MAX_BYTES },
};

function detail(e: ApiResponseError): string {
  const data = e.data as { detail?: string; title?: string; errors?: unknown } | undefined;
  const msg = data?.detail ?? data?.title ?? JSON.stringify(data?.errors ?? data ?? {});
  return `${e.code} ${String(msg).slice(0, 300)}`;
}

/** Map any error from twitter-api-v2 to a typed XError. */
export function mapXError(e: unknown, stage: string): XError {
  if (e instanceof XError) return e;
  if (e instanceof ApiResponseError) {
    if (e.code === 401 || e.code === 403 || e.isAuthError) return new XAuthError(`X ${stage}: auth error ${detail(e)}`, e.code, e);
    if (e.rateLimitError) return new XError(`X ${stage}: rate limited ${detail(e)}`, "rate_limit", e.code, e);
    if (e.code >= 500) return new XError(`X ${stage}: server error ${detail(e)}`, "transient", e.code, e);
    return new XError(`X ${stage}: ${detail(e)}`, "permanent", e.code, e);
  }
  if (e instanceof ApiRequestError) return new XError(`X ${stage}: request failed ${e.requestError?.message ?? e.message}`, "transient", undefined, e);
  // The response was cut mid-way: the outcome is unknown. "transient" is safe for uploads; the publisher never
  // retries a tweet on "transient" (only on "rate_limit"), so this cannot double-post.
  if (e instanceof ApiPartialResponseError) return new XError(`X ${stage}: partial response ${e.message}`, "transient", undefined, e);
  return new XError(`X ${stage}: ${(e as Error)?.message ?? String(e)}`, "permanent", undefined, e);
}

export interface XClient {
  /** Upload one image/video, wait for processing, attach alt text (images). Returns the media id. */
  uploadMedia(file: MediaFile, altText?: string | null): Promise<string>;
  postTweet(text: string, mediaIds: string[]): Promise<{ id: string; url: string }>;
  whoami(): Promise<{ id: string; username: string }>;
}

export interface XClientOptions {
  api?: XApi;
  sleep?: (ms: number) => Promise<void>;
  processingTimeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function tweetUrl(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

export function createXClient(creds: XCreds, opts: XClientOptions = {}): XClient {
  const api: XApi =
    opts.api ??
    new TwitterApi({
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      accessToken: creds.accessToken,
      accessSecret: creds.accessSecret,
    }).v2;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.processingTimeoutMs ?? PROCESSING_TIMEOUT_MS;

  /** Poll GET /2/media/upload?command=STATUS until processing_info says succeeded (or is absent). */
  async function waitForProcessing(mediaId: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let res: { data?: { processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } } };
      try {
        res = await api.get("media/upload", { command: "STATUS", media_id: mediaId });
      } catch (e) {
        throw mapXError(e, "media status");
      }
      const info = res.data?.processing_info;
      if (!info || info.state === "succeeded") return;
      if (info.state === "failed") {
        throw new XError(`X media processing failed: ${info.error?.message ?? "unknown"}`, "permanent");
      }
      if (Date.now() >= deadline) throw new XError(`X media processing timed out for ${mediaId}`, "transient");
      const waitS = Math.min(60, Math.max(1, info.check_after_secs ?? 5));
      await sleep(waitS * 1000);
    }
  }

  return {
    async uploadMedia(file, altText) {
      const mime = MIME_ALIASES[file.mime] ?? file.mime;
      const rule = ALLOWED[mime];
      if (!rule) throw new XError(`unsupported media type ${file.mime} (${file.path})`, "permanent");
      if (!fs.existsSync(file.path)) throw new XError(`media file missing: ${file.path}`, "permanent");
      const size = fs.statSync(file.path).size;
      if (size === 0) throw new XError(`media file empty: ${file.path}`, "permanent");
      if (size > rule.max) throw new XError(`media too large: ${file.path} ${size} > ${rule.max} bytes`, "permanent");

      const buf = await fs.promises.readFile(file.path);
      let mediaId: string;
      try {
        // v2 chunked upload: INIT -> APPEND* -> FINALIZE (library also polls processing_info).
        mediaId = await api.uploadMedia(
          buf,
          { media_type: mime as "image/png", media_category: rule.category },
          rule.category === "tweet_video" ? VIDEO_CHUNK_BYTES : undefined,
        );
      } catch (e) {
        throw mapXError(e, "media upload");
      }
      // Our own bounded wait as well: the library stops polling when check_after_secs is missing.
      if (rule.category === "tweet_video") await waitForProcessing(mediaId);

      const alt = altText?.trim();
      if (alt) {
        if (rule.category === "tweet_image") {
          try {
            await api.createMediaMetadata(mediaId, { alt_text: { text: alt.slice(0, ALT_TEXT_MAX) } });
          } catch (e) {
            const err = mapXError(e, "media metadata");
            if (err.kind === "auth") throw err;
            log.warn({ mediaId, err: err.message }, "alt text not set; continuing");
          }
        } else {
          log.debug({ mediaId }, "alt text skipped for video (metadata endpoint supports images/GIFs only)");
        }
      }
      return mediaId;
    },

    async postTweet(text, mediaIds) {
      if (mediaIds.length > 4) throw new XError(`too many media ids: ${mediaIds.length} (max 4)`, "permanent");
      const payload = mediaIds.length ? { media: { media_ids: mediaIds as [string] } } : undefined;
      try {
        const res = await api.tweet(text, payload);
        const id = res.data.id;
        return { id, url: tweetUrl(id) };
      } catch (e) {
        throw mapXError(e, "tweet");
      }
    },

    async whoami() {
      try {
        const res = await api.me();
        return { id: res.data.id, username: res.data.username };
      } catch (e) {
        throw mapXError(e, "whoami");
      }
    },
  };
}

// ---------- factory (overridable in tests) ----------

type XClientFactory = (product: Product) => XClient;

const defaultFactory: XClientFactory = (product) => {
  if (!product.xCreds) throw new XAuthError(`no X credentials for ${product.config.slug} (products/${product.config.slug}/.env)`);
  return createXClient(product.xCreds);
};

let factory: XClientFactory = defaultFactory;

export function getXClient(product: Product): XClient {
  return factory(product);
}

/** Tests: inject a fake client. Pass null to restore the real one. */
export function setXClientFactory(f: XClientFactory | null): void {
  factory = f ?? defaultFactory;
}
