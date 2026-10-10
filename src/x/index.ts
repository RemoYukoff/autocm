// X through the product's logged-in browser profile (data/sessions/<slug>/). No X API.
// Importing this module registers the browser client as the default XClient (src/publish/index.ts does that).
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { deleteXAccount, getDb, getXAccount, insertMetrics, listXAccounts, markXAccount, nowIso, saveXAccount } from "../core/db/index.ts";
import { track } from "../core/inflight.ts";
import { log } from "../core/log.ts";
import { PRODUCTS_DIR, sessionDir } from "../core/paths.ts";
import type { XAccount } from "../core/types.ts";
import { setDefaultXClientFactory, XAuthError, XError } from "../publish/x.ts";
import { debugScreenshot, hasAuthCookie, withSession, withSlugLock } from "./browser.ts";
import { BrowserXClient } from "./client.ts";
import { GraphqlTap, readMetrics, readProfile, requireAuthCookie, sleep, xUrl } from "./ops.ts";
import { AUTH_COOKIE, PATHS, WAIT, X_ORIGIN } from "./selectors.ts";

export { BrowserXClient } from "./client.ts";

setDefaultXClientFactory((product) => new BrowserXClient(product));

/** File name of the downloaded X avatar in products/<slug>/assets/ (not x-avatar.*: those are the brand's source designs). */
export const AVATAR_BASENAME = "x-profile-avatar";

export interface ConnectOptions {
  origin?: string;
  /** false (default) opens a visible window for the user to log in. */
  headless?: boolean;
  /** How long to wait for the login. Default 10 min. */
  timeoutMs?: number;
  pollMs?: number;
  /** Where the avatar goes. Default products/<slug>/assets/. */
  avatarDir?: string;
  profileDir?: string;
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

/** connectX with injectable origin/headless/paths (tests drive a local fixture headless). */
export function connectWithBrowser(slug: string, o: ConnectOptions = {}): Promise<XAccount> {
  const origin = o.origin ?? X_ORIGIN;
  return withSession(slug, { origin, headless: o.headless ?? false, profileDir: o.profileDir }, async (ctx, loginPage) => {
    if (!(await hasAuthCookie(ctx, origin, AUTH_COOKIE))) {
      await loginPage.goto(xUrl(origin, PATHS.login), { waitUntil: "domcontentloaded", timeout: WAIT.navigation }).catch((e) => {
        log.warn({ err: (e as Error).message.split("\n")[0] }, "x: login page slow to load; still waiting for the login");
      });
      log.info({ product: slug }, "x: waiting for the login in the browser window");
      await waitForLogin(ctx, loginPage, origin, o.timeoutMs ?? WAIT.login, o.pollMs ?? 1500);
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

export interface CollectOptions {
  origin?: string;
  /** Pause between post pages (plus up to 50% jitter). Default 4 s. */
  pauseMs?: number;
  /** Profile directory per slug; default data/sessions/<slug>/. */
  profileDir?: (slug: string) => string;
}

/** collectMetrics with injectable origin/pause (tests). */
export async function collectMetricsWith(days: number, o: CollectOptions = {}): Promise<number> {
  const origin = o.origin ?? X_ORIGIN;
  const pauseMs = o.pauseMs ?? 4000;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let updated = 0;
  for (const account of listXAccounts()) {
    const slug = account.product;
    const profileDir = o.profileDir?.(slug) ?? sessionDir(slug);
    if (!fs.existsSync(profileDir)) continue;
    const posts = getDb()
      .prepare(
        `SELECT id, tweet_id FROM posts WHERE product = ? AND status = 'published' AND tweet_id IS NOT NULL AND published_at >= ?
         ORDER BY published_at DESC`,
      )
      .all(slug, since) as { id: number; tweet_id: string }[];
    if (!posts.length) continue;

    try {
      const n = await withSession(slug, { origin, profileDir, headless: true }, async (ctx, page) => {
        const tap = new GraphqlTap(page);
        let ok = 0;
        try {
          await requireAuthCookie(ctx, origin);
          for (const [i, p] of posts.entries()) {
            if (i) await sleep(pauseMs + Math.random() * pauseMs * 0.5);
            try {
              insertMetrics(p.id, await readMetrics(page, tap, origin, account.handle, p.tweet_id));
              ok++;
            } catch (e) {
              if (e instanceof XAuthError) throw e;
              log.warn({ product: slug, post: p.id, err: (e as Error).message }, "x: metrics not read");
            }
          }
        } finally {
          tap.stop();
        }
        return ok;
      });
      updated += n;
      if (n) markXAccount(slug, { ok: true });
      log.info({ product: slug, updated: n, posts: posts.length }, "x: metrics collected");
    } catch (e) {
      const msg = (e as Error).message;
      if (e instanceof XAuthError) markXAccount(slug, { ok: false, error: msg });
      log.warn({ product: slug, err: msg }, "x: metrics collection failed");
    }
  }
  return updated;
}

/** Read fresh metrics for published posts of the last `days` days. Returns how many posts were updated. */
export async function collectMetrics(days = 7): Promise<number> {
  return collectMetricsWith(days);
}
