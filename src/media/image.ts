// HTML template -> PNG with Playwright. Data is injected as window.__DATA__; the template fills the DOM,
// fits the copy and sets window.__ready. Pages are served from a fake origin through page.route so ES
// modules, fonts and images load without file:// restrictions.
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright-core";
import { TEMPLATES_DIR } from "../core/paths.ts";
import type { MediaCopy, MediaFile, Product, TemplateId } from "../core/types.ts";
import { launchBrowser } from "./browser.ts";
import { brandCssVars, fontFaceCss, resolveBrand, type Brand, type Theme } from "./brand.ts";
import { parseHighlights, splitComparison, type Segment } from "./copy.ts";
import { pngSize } from "./files.ts";

export type ImageSize = "landscape" | "portrait";
export const IMAGE_SIZES: Record<ImageSize, { w: number; h: number }> = {
  landscape: { w: 1600, h: 900 },
  portrait: { w: 1080, h: 1350 },
};

const ORIGIN = "http://autocm.local";

export interface TemplateRequest {
  templateId: TemplateId;
  copy: MediaCopy;
  product: Product;
  size?: ImageSize;
  theme?: Theme;
  /** Absolute path of a product screenshot (screenshot template). */
  screen?: string;
  /** Absolute path of a generated background (ai_image composite). */
  background?: string;
  eyebrow?: string;
}

export interface TemplateData {
  template: TemplateId;
  size: { w: number; h: number };
  theme: Theme;
  brand: { name: string; host: string; logo: string | null };
  eyebrow: string | null;
  headline: Segment[];
  lines: Segment[][];
  stat: string | null;
  leftLabel: string | null;
  rightLabel: string | null;
  rows: [Segment[], Segment[]][];
  screen: string | null;
  background: string | null;
}

export interface TemplateReport {
  fit: { name: string; scale: number; ok: boolean }[];
  fonts: { family: string; weight: string; status: string }[];
  images: { src: string; ok: boolean }[];
}

export function buildTemplateData(req: TemplateRequest, brand: Brand): TemplateData {
  const { copy } = req;
  const hw = copy.highlight_words ?? [];
  const p = (t: string) => parseHighlights(t, hw);
  const lines = (copy.lines ?? []).filter((l) => l.trim());
  return {
    template: req.templateId,
    size: IMAGE_SIZES[req.size ?? "landscape"],
    theme: brand.theme,
    brand: { name: brand.name, host: brand.host, logo: brand.logo },
    eyebrow: req.eyebrow ?? null,
    headline: p(copy.headline),
    lines: lines.map(p),
    stat: copy.stat ?? null,
    leftLabel: copy.left_label ?? null,
    rightLabel: copy.right_label ?? null,
    rows: req.templateId === "comparison" ? lines.map((l) => splitComparison(l).map(p) as [Segment[], Segment[]]) : [],
    screen: req.screen ? `${ORIGIN}/asset/screen${path.extname(req.screen)}` : null,
    background: req.background ? `${ORIGIN}/asset/background${path.extname(req.background)}` : null,
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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

/** Resolve `rel` under `base`, refusing anything that escapes it. */
function under(base: string, rel: string): string | null {
  const abs = path.resolve(base, decodeURIComponent(rel));
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

/** Render one template to `outPath`. Pass a browser to reuse it; otherwise one is launched and closed. */
export async function renderTemplate(
  req: TemplateRequest,
  outPath: string,
  browser?: Browser,
): Promise<{ file: MediaFile; report: TemplateReport; notes: string[] }> {
  const dir = path.join(TEMPLATES_DIR, "image", req.templateId);
  if (!fs.existsSync(path.join(dir, "index.html"))) throw new Error(`template "${req.templateId}" not found in ${dir}`);
  const brand = resolveBrand(req.product, req.theme ?? "dark");
  const data = buildTemplateData(req, brand);
  const notes = [...brand.notes];

  // A product fonts.css is imported as-is (its relative urls resolve under /product/); otherwise
  // @font-face rules are generated for the product files. The bundled fallback is always declared.
  const fontFiles = brand.fonts;
  const css = [
    brand.fontsCss ? `@import url("${ORIGIN}/product/${path.relative(req.product.dir, brand.fontsCss)}");` : "",
    brandCssVars(brand),
    fontFaceCss(fontFiles, (_f, i) => `${ORIGIN}/font/${i}`),
  ].join("\n");
  const assets: Record<string, string | undefined> = { screen: req.screen, background: req.background };

  const own = !browser;
  const b = browser ?? (await launchBrowser());
  const ctx = await b.newContext({
    viewport: data.size.w ? { width: data.size.w, height: data.size.h } : undefined,
    deviceScaleFactor: 1,
    colorScheme: brand.theme,
  });
  try {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      let file: string | null = null;
      if (p === "/brand.css") return route.fulfill({ status: 200, contentType: MIME[".css"], body: css });
      if (p.startsWith("/templates/")) file = under(TEMPLATES_DIR, p.slice("/templates/".length));
      else if (p.startsWith("/product/")) file = under(req.product.dir, p.slice("/product/".length));
      else if (p.startsWith("/font/")) file = fontFiles[Number(p.slice("/font/".length))]?.file ?? null;
      else if (p.startsWith("/asset/")) file = assets[path.basename(p).replace(/\.[^.]+$/, "")] ?? null;
      if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
      return route.fulfill({
        status: 200,
        contentType: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        body: fs.readFileSync(file),
      });
    });
    await page.addInitScript((d) => {
      (window as unknown as { __DATA__: unknown }).__DATA__ = d;
    }, data);
    await page.goto(`${ORIGIN}/templates/image/${req.templateId}/index.html`, { waitUntil: "load" });
    await page
      .waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 20_000 })
      .catch(() => {
        throw new Error(`template ${req.templateId} never became ready: ${errors.join(" | ") || "no page errors"}`);
      });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const report = (await page.evaluate(() => (window as unknown as { __report: unknown }).__report)) as TemplateReport;

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: "png", clip: { x: 0, y: 0, width: data.size.w, height: data.size.h } });

    for (const f of report.fit) if (!f.ok) notes.push(`text overflow risk in ${f.name} (scale ${f.scale})`);
    const failed = report.fonts.filter((f) => f.status !== "loaded");
    if (failed.length) notes.push(`fonts not loaded: ${failed.map((f) => `${f.family} ${f.weight}`).join(", ")}`);
    const badImg = report.images.filter((i) => !i.ok);
    if (badImg.length) notes.push(`images failed: ${badImg.map((i) => i.src).join(", ")}`);
    if (errors.length) notes.push(`page errors: ${errors.join(" | ")}`);

    const { width, height } = pngSize(outPath);
    return {
      file: { path: path.resolve(outPath), mime: "image/png", width, height, bytes: fs.statSync(outPath).size },
      report,
      notes,
    };
  } finally {
    await ctx.close();
    if (own) await b.close();
  }
}
