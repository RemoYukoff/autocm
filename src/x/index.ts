// X through the product's logged-in browser profile (data/sessions/<slug>/). No X API.
// Importing this module registers the browser client as the default XClient (src/publish/index.ts does that).
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { deleteXAccount, getXAccount, nowIso, saveXAccount } from "../core/db/index.ts";
import { track } from "../core/inflight.ts";
import { log } from "../core/log.ts";
import { PRODUCTS_DIR, sessionDir } from "../core/paths.ts";
import type { XAccount } from "../core/types.ts";
import { setDefaultXClientFactory, XError } from "../publish/x.ts";
import { debugScreenshot, hasAuthCookie, withSession, withSlugLock } from "./browser.ts";
import { BrowserXClient } from "./client.ts";
import { GraphqlTap, readProfile, sleep, xUrl } from "./ops.ts";
import { AUTH_COOKIE, PATHS, WAIT, X_ORIGIN } from "./selectors.ts";

export { BrowserXClient } from "./client.ts";

setDefaultXClientFactory((product) => new BrowserXClient(product));

/** File name of the downloaded X avatar in products/<slug>/assets/ (not x-avatar.*: those are the brand's source designs). */
export const AVATAR_BASENAME = "x-profile-avatar";

export interface ConnectOptions {
  /** Where the avatar goes. Default products/<slug>/assets/. */
  avatarDir?: string;
}

/** Resolves once the profile has X's session cookie; rejects if the window is closed or time runs out. */
async function waitForLogin(ctx: BrowserContext, page: Page, origin: string, timeoutMs: number, pollMs: number): Promise<void> {
  let closed = false;
  const onClose = () => {
    closed = true;
  };
  ctx.once("close", onClose);
  page.once("close", () => {
    if (ctx.pages().length === 0) closed = true;
  });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (closed || ctx.pages().length === 0) throw new XError("the login window was closed before logging in to X", "permanent");
      if (await hasAuthCookie(ctx, origin, AUTH_COOKIE)) return;
      if (Date.now() > deadline) throw new XError(`no X login within ${Math.round(timeoutMs / 60_000)} min: try again`, "transient");
      await sleep(pollMs);
    }
  } finally {
    ctx.off("close", onClose);
  }
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** Download the avatar with the browser's request context into `dir`. Returns the absolute path, or null. */
async function downloadAvatar(ctx: BrowserContext, url: string | null, dir: string): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await ctx.request.get(url, { timeout: 30_000 });
    if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
    const type = (res.headers()["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = EXT[type] ?? /\.(jpe?g|png|webp|gif)(\?|$)/i.exec(url)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "jpg";
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${AVATAR_BASENAME}.`)) fs.rmSync(path.join(dir, f), { force: true });
    const file = path.join(dir, `${AVATAR_BASENAME}.${ext}`);
    fs.writeFileSync(file, await res.body());
    return file;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "x: could not download the avatar");
    return null;
  }
}

/** connectX with the avatar saved where the caller wants it. */
export function connectWithBrowser(slug: string, o: ConnectOptions = {}): Promise<XAccount> {
  const origin = X_ORIGIN;
  return withSession(slug, { headless: false }, async (ctx, loginPage) => {
    if (!(await hasAuthCookie(ctx, origin, AUTH_COOKIE))) {
      await loginPage.goto(xUrl(origin, PATHS.login), { waitUntil: "domcontentloaded", timeout: WAIT.navigation }).catch((e) => {
        log.warn({ err: (e as Error).message.split("\n")[0] }, "x: login page slow to load; still waiting for the login");
      });
      log.info({ product: slug }, "x: waiting for the login in the browser window");
      await waitForLogin(ctx, loginPage, origin, WAIT.login, 1500);
    }
    // The user may have closed the original tab and logged in from another one.
    const page = loginPage.isClosed() ? (ctx.pages()[0] ?? (await ctx.newPage())) : loginPage;
    const tap = new GraphqlTap(page);
    try {
      let profile;
      try {
        profile = await readProfile(ctx, page, tap, origin);
      } catch (e) {
        const shot = await debugScreenshot(page, slug);
        throw shot && e instanceof Error ? Object.assign(e, { message: `${e.message} (screenshot: ${shot})` }) : e;
      }
      const avatar_path = await downloadAvatar(ctx, profile.avatar_url, o.avatarDir ?? path.join(PRODUCTS_DIR, slug, "assets"));
      const now = nowIso();
      saveXAccount({ product: slug, handle: profile.handle, name: profile.name, avatar_path, connected_at: now, last_ok_at: now, error: null });
      log.info({ product: slug, handle: profile.handle }, "x: account connected");
      return getXAccount(slug)!;
    } finally {
      tap.stop();
    }
  });
}

/**
 * Open a visible browser at x.com/login on the product's profile, wait for the user to log in (up to ~10 min),
 * read the profile, save the x_accounts row (and avatar into products/<slug>/assets/), close the window.
 */
export async function connectX(slug: string): Promise<XAccount> {
  return connectWithBrowser(slug);
}

/** Delete the product's browser profile and x_accounts row. */
export async function disconnectX(slug: string): Promise<void> {
  await track(
    withSlugLock(slug, async () => {
      fs.rmSync(sessionDir(slug), { recursive: true, force: true });
      deleteXAccount(slug);
      log.info({ product: slug }, "x: account disconnected");
    }),
  );
}

