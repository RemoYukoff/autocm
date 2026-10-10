// X client contract. The real client drives the product's logged-in browser profile (src/x/); there is no X API.
// Tests must inject a fake with setXClientFactory: the real one refuses to run under vitest.
import type { MediaFile, Product, XMetrics, XProfile } from "../core/types.ts";

export type XErrorKind = "auth" | "rate_limit" | "transient" | "permanent";

export class XError extends Error {
  readonly kind: XErrorKind;
  constructor(message: string, kind: XErrorKind, cause?: unknown) {
    super(message, { cause });
    this.name = "XError";
    this.kind = kind;
  }
}

/** The browser session is logged out, locked or challenged. Publisher pauses on this. */
export class XAuthError extends XError {
  constructor(message: string, cause?: unknown) {
    super(message, "auth", cause);
    this.name = "XAuthError";
  }
}

export function mapXError(e: unknown, stage: string): XError {
  if (e instanceof XError) return e;
  return new XError(`X ${stage}: ${(e as Error)?.message ?? String(e)}`, "permanent", e);
}

export function tweetUrl(id: string, handle?: string): string {
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

export interface XClient {
  /**
   * Compose and send one post with up to 4 media files. Resolves once X confirms it, with the new post's id.
   * Never retried by the caller: a failure after the Post click may still have created the post.
   */
  post(text: string, media: MediaFile[], altText?: string | null): Promise<{ id: string; url: string }>;
  /** Profile of the logged-in account. Throws XAuthError when logged out. */
  profile(): Promise<XProfile>;
  /** Engagement counts of one of the account's posts. */
  metrics(tweetId: string): Promise<XMetrics>;
}

export type XClientFactory = (product: Product) => XClient;

let defaultFactory: XClientFactory = () => {
  throw new XError("browser X client not installed", "permanent");
};
let factory: XClientFactory | null = null;

/** src/x/ registers the browser client here at import time. */
export function setDefaultXClientFactory(f: XClientFactory): void {
  defaultFactory = f;
}

export function getXClient(product: Product): XClient {
  // Tests must never reach the real X.
  if (process.env.VITEST && !factory) throw new Error("tests must mock the X client (setXClientFactory)");
  return (factory ?? defaultFactory)(product);
}

/** Tests: inject a fake client. Pass null to restore the real one. */
export function setXClientFactory(f: XClientFactory | null): void {
  factory = f;
}
