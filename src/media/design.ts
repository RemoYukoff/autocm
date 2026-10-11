// Designer HTML -> PNG with Playwright. The designer agent (src/agents/designer.ts) writes a whole HTML page; it is
// served from a fake origin next to the brand stylesheet, fonts, logo and product screenshots, rendered at the
// canvas size, and checked for layout problems the designer has to fix (text clipped or off the canvas, text too
// small for a phone, fonts that do not exist, overlapping text). Nothing outside the fake origin loads.
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright-core";
import { productPath } from "../core/config.ts";
import type { ImageAspect, MediaFile, Product } from "../core/types.ts";
import { launchBrowser } from "./browser.ts";
import { fontFaceCss, logoFile, resolveFonts, type FontFile } from "./brand.ts";
import { pngSize } from "./files.ts";

export const IMAGE_SIZES: Record<ImageAspect, { w: number; h: number }> = {
  landscape: { w: 1600, h: 900 },
  square: { w: 1200, h: 1200 },
  portrait: { w: 1080, h: 1350 },
};

/** Smallest text that still reads on a phone, where the image shows ~390 px wide: ~2.2% of the canvas width. */
export function minFontPx(w: number): number {
  return Math.round(w * 0.022);
}

const ORIGIN = "http://autocm.local";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/** URLs the designer can use in its HTML, with what they are. */
export interface DesignKit {
  /** CSS custom properties defined by /brand.css, with their values. */
  vars: Record<string, string>;
  /** Font families that are loaded (product fonts first). */
  families: string[];
  logos: { url: string; use: string }[];
  screens: { url: string; description: string }[];
}

interface Served {
  css: string;
  fonts: FontFile[];
  files: Map<string, { body: Buffer; type: string }>;
  kit: DesignKit;
}

function serve(product: Product): Served {
  const c = product.config;
  const col = c.brand.colors;
  const { fonts, fontsCss } = resolveFonts(product);
  const sans = c.brand.fonts.sans;
  const mono = c.brand.fonts.mono;
  const vars: Record<string, string> = {
    "--brand-primary": col.primary,
    "--brand-accent": col.accent,
    "--brand-ink": col.ink,
    "--brand-bg": col.bg,
    "--brand-muted": col.muted ?? "#71717A",
    "--font-sans": `"${sans}", "autocm-sans", sans-serif`,
    "--font-mono": `${mono ? `"${mono}", ` : ""}"autocm-mono", monospace`,
  };
  const files = new Map<string, { body: Buffer; type: string }>();
  const logos: DesignKit["logos"] = [];
  for (const theme of ["dark", "light"] as const) {
    const logo = logoFile(product, theme);
    if (!logo) continue;
    const url = `/brand/logo-on-${theme}${logo.ext}`;
    files.set(url, { body: logo.body, type: MIME[logo.ext] ?? "application/octet-stream" });
    logos.push({ url, use: `logo for a ${theme} background` });
  }
  const screens: DesignKit["screens"] = [];
  for (const s of c.assets.screens) {
    const file = productPath(product, s.path);
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file).toLowerCase();
    const url = `/screens/${s.id}${ext}`;
    files.set(url, { body: fs.readFileSync(file), type: MIME[ext] ?? "application/octet-stream" });
    screens.push({ url, description: s.description });
  }
  const css = [
    fontsCss ? `@import url("${ORIGIN}/product/${path.relative(product.dir, fontsCss)}");` : "",
    fontFaceCss(fonts, (_f, i) => `${ORIGIN}/font/${i}`),
    `:root{${Object.entries(vars).map(([k, v]) => `${k}:${v};`).join("")}}`,
  ].join("\n");
  const families = [...new Set([sans, ...(mono ? [mono] : [])])];
  return { css, fonts, files, kit: { vars, families, logos, screens } };
}

/** What the designer can use: brand variables, fonts, logos and screenshots. */
export function designKit(product: Product): DesignKit {
  return serve(product).kit;
}

/** The canvas reset and brand stylesheet go first in <head>, so the designer's own CSS can override anything. */
function withBase(html: string, w: number, h: number): string {
  const base = `<meta charset="utf-8"><link rel="stylesheet" href="${ORIGIN}/brand.css"><style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + base);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${base}</head>`);
  return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
}

interface PageReport {
  offCanvas: string[];
  clipped: string[];
  tiny: { text: string; px: number }[];
  missingFonts: string[];
  overlaps: string[];
  brokenImages: string[];
  words: number;
}

export interface DesignRender {
  file: MediaFile;
  /** Layout problems found on the page, phrased for the designer. Empty = clean. */
  problems: string[];
}

export interface RenderOptions {
  /** Reuse this browser instead of launching one. */
  browser?: Browser;
  /** Files the page references as `asset:<name>` (name -> file on disk), e.g. generated images. */
  assets?: Record<string, string>;
  /** Pause every CSS animation at this many seconds before the screenshot (video scenes). */
  seek?: number;
}

/** Render designer HTML to `outPath` at the canvas size (an image aspect, or explicit pixels for video scenes). */
export async function renderDesign(html: string, product: Product, size: ImageAspect | { w: number; h: number }, outPath: string, opts: RenderOptions = {}): Promise<DesignRender> {
  const { browser, assets = {}, seek } = opts;
  const { w, h } = typeof size === "string" ? IMAGE_SIZES[size] : size;
  const served = serve(product);
  for (const [name, file] of Object.entries(assets)) served.files.set(`/asset/${name}`, { body: fs.readFileSync(file), type: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
  const page_ = withBase(html.replace(/asset:([A-Za-z0-9._-]+)/g, "/asset/$1"), w, h);
  const blocked = new Set<string>();
  const errors: string[] = [];

  const own = !browser;
  const b = browser ?? (await launchBrowser());
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, javaScriptEnabled: true });
  try {
    // tsx/esbuild may wrap named functions in __name(); define it so inspectPage runs unchanged in the page.
    await ctx.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) {
        if (!url.protocol.startsWith("data")) blocked.add(url.href.slice(0, 120));
        return url.protocol === "data:" ? route.continue() : route.abort();
      }
      const p = decodeURIComponent(url.pathname);
      if (p === "/design.html") return route.fulfill({ status: 200, contentType: MIME[".html"], body: page_ });
      if (p === "/brand.css") return route.fulfill({ status: 200, contentType: MIME[".css"], body: served.css });
      const asset = served.files.get(p);
      if (asset) return route.fulfill({ status: 200, contentType: asset.type, body: asset.body });
      let file: string | null = null;
      if (p.startsWith("/font/")) file = served.fonts[Number(p.slice("/font/".length))]?.file ?? null;
      else if (p.startsWith("/product/")) {
        const abs = path.resolve(product.dir, p.slice("/product/".length));
        if (abs.startsWith(product.dir + path.sep)) file = abs;
      }
      if (!file || !fs.existsSync(file)) {
        blocked.add(p);
        return route.fulfill({ status: 404, body: "not found" });
      }
      return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(file) });
    });
    await page.goto(`${ORIGIN}/design.html`, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(async (t) => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
      // Same seek as remotion/src/Edit.tsx: paused, delay shifted back by t.
      if (t !== null)
        for (const el of document.querySelectorAll<HTMLElement>("*")) {
          const cs = getComputedStyle(el);
          if (cs.animationName === "none") continue;
          el.style.animationDelay = cs.animationDelay.split(",").map((d) => `${(d.trim().endsWith("ms") ? parseFloat(d) / 1000 : parseFloat(d)) - t}s`).join(",");
          el.style.animationPlayState = "paused";
        }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, seek ?? null);
    const report = (await page.evaluate(inspectPage, { w, h, min: minFontPx(w) })) as PageReport;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: "png", clip: { x: 0, y: 0, width: w, height: h } });

    const problems: string[] = [];
    for (const t of report.offCanvas) problems.push(`Text runs off the canvas: "${t}"`);
    for (const t of report.clipped) problems.push(`Text is cut off by its box: "${t}"`);
    if (report.tiny.length)
      problems.push(`Text under ${minFontPx(w)}px is hard to read on a phone: ${report.tiny.map((t) => `"${t.text}" (${t.px}px)`).join(", ")}`);
    for (const f of report.missingFonts) problems.push(`Font "${f}" is not available and fell back to another font; use var(--font-sans) or var(--font-mono)`);
    for (const t of report.overlaps) problems.push(`Text overlaps other text: ${t}`);
    for (const s of report.brokenImages) problems.push(`Image did not load: ${s}`);
    for (const u of blocked) problems.push(`Blocked request (only the provided URLs load; draw it with HTML/CSS/SVG instead): ${u}`);
    for (const e of errors) problems.push(`Page error: ${e}`);
    if (report.words > 45) problems.push(`${report.words} words on the image; a feed image reads in two seconds, cut to the essentials`);

    const { width, height } = pngSize(outPath);
    return { file: { path: path.resolve(outPath), mime: "image/png", width, height, bytes: fs.statSync(outPath).size }, problems };
  } finally {
    await ctx.close();
    if (own) await b.close();
  }
}

/** Runs in the page: find text that is off the canvas, clipped, too small, overlapping or in a missing font. */
function inspectPage({ w, h, min }: { w: number; h: number; min: number }): PageReport {
  const snip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "emoji", "math", "inherit", "initial"]);
  const loaded = new Set<string>();
  document.fonts.forEach((f) => {
    if (f.status === "loaded") loaded.add(f.family.replace(/^["']|["']$/g, "").toLowerCase());
  });

  // Elements that directly hold visible text.
  const texts: { el: HTMLElement; text: string; rect: DOMRect }[] = [];
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join(" ").trim();
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    texts.push({ el, text: own, rect });
  }

  const offCanvas: string[] = [];
  const tiny: { text: string; px: number }[] = [];
  const missing = new Set<string>();
  for (const t of texts) {
    const r = t.rect;
    if (r.left < -2 || r.top < -2 || r.right > w + 2 || r.bottom > h + 2) offCanvas.push(snip(t.text));
    const cs = getComputedStyle(t.el);
    const px = parseFloat(cs.fontSize);
    if (px < min && /[\p{L}\p{N}]/u.test(t.text)) tiny.push({ text: snip(t.text), px: Math.round(px) });
    const first = cs.fontFamily.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
    if (!generic.has(first.toLowerCase()) && !loaded.has(first.toLowerCase())) missing.add(first);
  }

  const clipped: string[] = [];
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
    const cs = getComputedStyle(el);
    const hides = (v: string) => v === "hidden" || v === "clip" || v === "auto" || v === "scroll";
    if (!hides(cs.overflowX) && !hides(cs.overflowY)) continue;
    if (!(el.textContent ?? "").trim()) continue;
    const x = hides(cs.overflowX) && el.scrollWidth > el.clientWidth + 2;
    const y = hides(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
    if ((x || y) && el !== document.body && el !== document.documentElement) clipped.push(snip(el.textContent ?? ""));
  }
  // Text spilling well out of a fixed-height box without overflow:hidden still collides with what follows
  // (a few px of glyph overhang from tight leading is normal).
  for (const t of texts) {
    const cs = getComputedStyle(t.el);
    const spill = t.el.scrollHeight - t.el.clientHeight;
    if (cs.overflowY === "visible" && cs.display !== "inline" && t.el.clientHeight > 0 && spill > Math.max(10, t.el.clientHeight * 0.15))
      clipped.push(`${snip(t.text)} (spills ${spill}px out of its ${Math.round(t.el.clientHeight)}px-tall box)`);
  }

  const overlaps: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ix = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const iy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (ix <= 4 || iy <= 4) continue;
      const small = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
      if ((ix * iy) / small > 0.15) overlaps.push(`"${snip(a.text)}" and "${snip(b.text)}"`);
    }
  }

  const brokenImages = [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute("src") ?? "(no src)");
  const words = texts.reduce((n, t) => n + t.text.split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)).length, 0);
  const uniq = (a: string[]) => [...new Set(a)].slice(0, 8);
  return { offCanvas: uniq(offCanvas), clipped: uniq(clipped), tiny: tiny.slice(0, 8), missingFonts: [...missing], overlaps: uniq(overlaps), brokenImages, words };
}
