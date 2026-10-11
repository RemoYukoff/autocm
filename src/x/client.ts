// XClient on the product's logged-in browser profile. One headless context per operation, serialized per slug.
import type { BrowserContext, Page } from "playwright-core";
import { getXAccount, markXAccount } from "../core/db/index.ts";
import { log } from "../core/log.ts";
import type { MediaFile, Product, XProfile } from "../core/types.ts";
import { XAuthError, XError, type XClient } from "../publish/x.ts";
import { debugScreenshot, withSession } from "./browser.ts";
import { composeAndPost, GraphqlTap, readProfile } from "./ops.ts";
import { X_ORIGIN } from "./selectors.ts";

/** Same error with " (screenshot: <path>)" appended. */
function withShot(e: unknown, shot: string | null, what: string): XError {
  const base = e instanceof XError ? e : new XError(`X ${what}: ${(e as Error)?.message?.split("\n")[0] ?? String(e)}`, "transient", e);
  if (!shot) return base;
  const message = `${base.message} (screenshot: ${shot})`;
  return base instanceof XAuthError ? new XAuthError(message, base.cause) : new XError(message, base.kind, base.cause);
}

export class BrowserXClient implements XClient {
  private readonly slug: string;

  constructor(private readonly product: Product) {
    this.slug = product.config.slug;
  }

  private handle(): string | null {
    return this.product.xAccount?.handle ?? getXAccount(this.slug)?.handle ?? null;
  }

  /** Run one operation in its own session; record the outcome on the account, screenshot on failure. */
  private run<T>(what: string, fn: (ctx: BrowserContext, page: Page, tap: GraphqlTap) => Promise<T>): Promise<T> {
    return withSession(this.slug, { headless: true }, async (ctx, page) => {
      const tap = new GraphqlTap(page);
      try {
        const out = await fn(ctx, page, tap);
        markXAccount(this.slug, { ok: true });
        return out;
      } catch (e) {
        const err = withShot(e, await debugScreenshot(page, this.slug), what);
        if (err instanceof XAuthError) markXAccount(this.slug, { ok: false, error: err.message });
        log.warn({ product: this.slug, op: what, kind: err.kind, err: err.message }, "x: browser operation failed");
        throw err;
      } finally {
        tap.stop();
      }
    });
  }

  post(text: string, media: MediaFile[], altText?: string | null): Promise<{ id: string; url: string }> {
    if (media.length > 4) return Promise.reject(new XError(`X allows at most 4 media per post (got ${media.length})`, "permanent"));
    return this.run("post", (ctx, page, tap) => composeAndPost(ctx, page, tap, X_ORIGIN, { text, media, altText, handle: this.handle() }));
  }

  profile(): Promise<XProfile> {
    return this.run("profile", (ctx, page, tap) => readProfile(ctx, page, tap, X_ORIGIN));
  }
}
