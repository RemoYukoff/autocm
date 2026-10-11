// The product's persistent browser profile (data/sessions/<slug>/): one launcher for the headed login and the
// headless operations so X sees the same browser both times, and a per-slug lock because Chromium cannot open
// one profile twice.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { track } from "../core/inflight.ts";
import { log } from "../core/log.ts";
import { OUT_DIR, sessionDir } from "../core/paths.ts";
import { XError } from "../publish/x.ts";

const CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");

/**
 * The full Chromium build (never chrome-headless-shell: its fingerprint differs from the headed login).
 * AUTOCM_X_CHROMIUM -> playwright-core's expected build if installed -> newest ~/.cache/ms-playwright/chromium-<rev>.
 */
export function xChromiumPath(): string {
  const fromEnv = process.env.AUTOCM_X_CHROMIUM;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p) && !p.includes("headless_shell")) return p;
  } catch {
    // not installed: scan the cache
  }
  if (fs.existsSync(CACHE)) {
    const builds = fs
      .readdirSync(CACHE)
      .map((d) => ({ d, rev: Number(/^chromium-(\d+)$/.exec(d)?.[1]) }))
      .filter((x) => Number.isFinite(x.rev))
      .sort((a, b) => b.rev - a.rev);
    for (const { d } of builds) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const p = path.join(CACHE, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error(`No full Chromium build found in ${CACHE}. Run \`npx playwright install chromium\` or set AUTOCM_X_CHROMIUM.`);
}

let uaCache: string | undefined;

/**
 * One normal Chrome user agent for both modes. Headless Chromium says "HeadlessChrome/<v>", which x.com answers
 * with an HTTP error, so it is replaced in headed and headless alike. The version tracks the installed build.
 */
export function xUserAgent(exe = xChromiumPath()): string {
  if (process.env.AUTOCM_X_USER_AGENT) return process.env.AUTOCM_X_USER_AGENT;
  if (uaCache) return uaCache;
  const out = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(out)?.[1] ?? "151";
  return (uaCache = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`);
}

/** Launch options shared by the headed login and headless operations: only `headless` differs. */
export function launchOptions(headless: boolean) {
  const executablePath = xChromiumPath();
  return {
    executablePath,
    channel: "chromium", // full Chromium in new headless mode, not the headless shell
    headless,
    userAgent: xUserAgent(executablePath),
    viewport: { width: 1280, height: 900 },
    // No "controlled by automated software" bar and navigator.webdriver === false in both modes.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };
}

// ---------- per-slug lock ----------

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier operation on `slug` (in this process) has settled. */
export function withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(slug) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(slug, tail);
  void tail.then(() => {
    if (chains.get(slug) === tail) chains.delete(slug);
  });
  return run;
}

// ---------- sessions ----------

export interface SessionOptions {
  headless: boolean;
}

function launchError(e: unknown, slug: string, dir: string): XError {
  const msg = (e as Error)?.message ?? String(e);
  if (/ProcessSingleton|SingletonLock|profile (appears to be|is) (in use|already)|user data directory is already in use/i.test(msg))
    return new XError(
      `browser profile ${dir} for ${slug} is in use by another process (is the autocm service running? stop it before \`x connect\`)`,
      "transient",
      e,
    );
  return new XError(`could not start the browser for ${slug}: ${msg.split("\n")[0]}`, "transient", e);
}

/**
 * Open the product's persistent profile, run `fn` with its page, close it. Serialized per slug and counted as
 * in flight so the --watch restarter waits for it.
 */
export function withSession<T>(slug: string, opts: SessionOptions, fn: (ctx: BrowserContext, page: Page) => Promise<T>): Promise<T> {
  return track(
    withSlugLock(slug, async () => {
      const dir = sessionDir(slug);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      let ctx: BrowserContext;
      try {
        ctx = await chromium.launchPersistentContext(dir, launchOptions(opts.headless));
      } catch (e) {
        throw launchError(e, slug, dir);
      }
      try {
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        return await fn(ctx, page);
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }),
  );
}

/** Whether the profile holds X's session cookie for `origin`. Never reads out the value. */
export async function hasAuthCookie(ctx: BrowserContext, origin: string, name: string): Promise<boolean> {
  const cookies = await ctx.cookies(origin).catch(() => []);
  return cookies.some((c) => c.name === name && c.value.length > 0);
}

/** Screenshot of the current page for debugging (never the HTML: it can carry tokens). Returns the path or null. */
export async function debugScreenshot(page: Page, slug: string): Promise<string | null> {
  try {
    if (page.isClosed()) return null;
    const dir = path.join(OUT_DIR, "x-debug", slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await page.screenshot({ path: file, timeout: 10_000 });
    return file;
  } catch (e) {
    log.warn({ slug, err: (e as Error).message }, "x: debug screenshot failed");
    return null;
  }
}
