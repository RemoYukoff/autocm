// Locate a Chromium for Playwright and Remotion without downloading anything.
// Order: AUTOCM_CHROMIUM env -> playwright-core's expected binary -> newest build in ~/.cache/ms-playwright.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

const CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");

function newestIn(prefix: string, rel: string[]): string | null {
  if (!fs.existsSync(CACHE)) return null;
  const dirs = fs
    .readdirSync(CACHE)
    .filter((d) => d.startsWith(`${prefix}-`))
    .map((d) => ({ d, rev: Number(d.slice(prefix.length + 1)) }))
    .filter((x) => Number.isFinite(x.rev))
    .sort((a, b) => b.rev - a.rev);
  for (const { d } of dirs) {
    for (const r of rel) {
      const p = path.join(CACHE, d, r);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

let cached: string | null | undefined;

/** Full Chromium for Playwright screenshots. */
export function chromiumPath(): string {
  if (cached) return cached;
  const fromEnv = process.env.AUTOCM_CHROMIUM;
  if (fromEnv && fs.existsSync(fromEnv)) return (cached = fromEnv);
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return (cached = p);
  } catch {
    // fall through to the cache scan
  }
  const found =
    newestIn("chromium_headless_shell", ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) ??
    newestIn("chromium", ["chrome-linux64/chrome", "chrome-linux/chrome"]);
  if (!found) throw new Error(`No Chromium found. Set AUTOCM_CHROMIUM or run \`npx playwright install chromium\` (looked in ${CACHE})`);
  return (cached = found);
}

/** chrome-headless-shell preferred for Remotion (it is what Remotion itself downloads). */
export function headlessShellPath(): string {
  const fromEnv = process.env.AUTOCM_CHROMIUM;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return newestIn("chromium_headless_shell", ["chrome-headless-shell-linux64/chrome-headless-shell"]) ?? chromiumPath();
}

// Flags from 4foodies render.mjs: switch off async raster so screenshots are stable run to run.
export const DETERMINISTIC_ARGS = [
  "--disable-gpu",
  "--disable-partial-raster",
  "--disable-checker-imaging",
  "--disable-image-animation-resync",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--run-all-compositor-stages-before-draw",
  "--disable-new-content-rendering-timeout",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
];

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: chromiumPath(), args: DETERMINISTIC_ARGS, headless: true });
}
