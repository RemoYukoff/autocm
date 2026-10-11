// Read a product's site with headless Chromium (homepage plus a few relevant same-origin pages), pick a logo and
// brand colors from the rendered page and screenshot it, then ask the LLM (which sees the screenshot) for a draft
// product.yaml, the design manual and an overview knowledge file.
// The draft is written as-is (src/dashboard/accounts.ts): nobody reviews it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { z } from "zod";
import { callJson } from "../llm.ts";
import { log } from "../core/log.ts";
import { launchBrowser } from "../media/browser.ts";
import { defaultCadence } from "./schema.ts";
import { slugify } from "./write.ts";

export interface Logo {
  data: Buffer;
  /** From the bytes, not the URL: .svg, .png, .jpg or .webp. */
  ext: string;
}


/** The image type of the bytes, by magic number (SVG by its root element). Null when not a usable logo. */
export function logoExt(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return ".webp";
  const head = buf.subarray(0, 4096).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return ".svg";
  return null;
}

function asLogo(data: Buffer): Logo | null {
  const ext = data.length && data.length <= LOGO_MAX_BYTES ? logoExt(data) : null;
  return ext ? { data, ext } : null;
}

export const PREFILL_STAGE = "product-draft";
const MAX_PAGES = 4;
const HOME_CHARS = 7000;
const PAGE_CHARS = 3500;
const NAV_TIMEOUT_MS = 20_000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export interface PageText {
  url: string;
  title: string;
  description: string;
  text: string;
}

export interface BrandColors {
  primary: string;
  accent: string;
  ink: string;
  bg: string;
  muted: string;
}

export interface SiteScrape {
  url: string;
  origin: string;
  language: string | null;
  siteName: string | null;
  font: string | null;
  meta: Record<string, string>;
  pages: PageText[];
  colors: BrandColors;
  logo: Logo | null;
  logoSource: string | null;
  /** PNG of the homepage's first screen: the designer's visual reference. */
  screenshot: Buffer;
}

export interface ProductDraft {
  /** Form-shaped config (not yet validated; the user reviews and saves it). */
  config: Record<string, unknown>;
  knowledge: { name: string; content: string }[];
  logo: Logo | null;
  /** PNG of the homepage, saved as the brand reference. */
  reference: Buffer;
  sources: string[];
  /** Choices made on the way (time zone fallback, logo source...), logged when the product is written. */
  notes: string[];
}

type Step = (msg: string) => void;

// ---------- URL helpers ----------

export function normalizeSiteUrl(raw: unknown): URL {
  let s = typeof raw === "string" ? raw.trim() : "";
  if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("Enter the product's website, e.g. https://example.com");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https websites can be read");
  if (u.username || u.password) throw new Error("Remove the user name and password from the URL");
  u.hash = "";
  return u;
}

const PAGE_HINTS: [RegExp, number][] = [
  [/pric|plans?\b|billing/i, 10],
  [/feature|product|how[-\s]?it[-\s]?works|solution|tour/i, 8],
  [/about|company|story|mission|team/i, 6],
  [/docs?\b|documentation|guide|faq|help|integrations?/i, 5],
  [/use[-\s]?cases?|customers?|why/i, 3],
  [/changelog|blog/i, 1],
];
const SKIP = /login|log-in|sign[-\s]?(in|up)|register|account|auth|privacy|terms|legal|cookie|careers|jobs|status|cart|checkout|\.(pdf|zip|png|jpe?g|svg|gif|webp|mp4|xml|json|ico)$/i;

/** Up to `max` same-origin pages worth reading, best first (pricing, features, about, docs). */
export function pickPages(links: { href: string; text: string }[], home: URL, max = MAX_PAGES): string[] {
  const scored = new Map<string, number>();
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.href, home);
    } catch {
      continue;
    }
    if (u.origin !== home.origin || !/^https?:$/.test(u.protocol)) continue;
    u.hash = "";
    u.search = "";
    const key = u.href.replace(/\/$/, "");
    if (key === home.href.replace(/\/$/, "") || u.pathname === "/" || SKIP.test(u.pathname)) continue;
    const hay = `${u.pathname} ${l.text}`;
    const score = Math.max(0, ...PAGE_HINTS.filter(([re]) => re.test(hay)).map(([, s]) => s));
    if (!score) continue;
    const depthPenalty = u.pathname.split("/").filter(Boolean).length - 1;
    scored.set(key, Math.max(scored.get(key) ?? 0, score - depthPenalty));
  }
  const ranked = [...scored].sort((a, b) => b[1] - a[1]).map(([href]) => href);
  const kindOf = (href: string) => PAGE_HINTS.findIndex(([re]) => re.test(new URL(href).pathname));
  // Best page of each kind first, so four pricing variants do not crowd out features and about; then the rest.
  const out: string[] = [];
  const kinds = new Set<number>();
  for (const href of ranked) {
    if (out.length < max && !kinds.has(kindOf(href))) {
      kinds.add(kindOf(href));
      out.push(href);
    }
  }
  for (const href of ranked) if (out.length < max && !out.includes(href)) out.push(href);
  return out;
}

// ---------- in-page extraction (runs in the browser) ----------

interface InPage {
  title: string;
  lang: string | null;
  meta: Record<string, string>;
  text: string;
  links: { href: string; text: string }[];
  logos: { kind: "svg" | "url"; score: number; svg?: string; url?: string }[];
  colors: BrandColors;
  font: string | null;
}

/* c8 ignore start */
function extract(): InPage {
  const toHex = (c: string): string | null => {
    const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\)/.exec(c);
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    if (alpha < 0.5) return null;
    return "#" + [m[1], m[2], m[3]].map((v) => Math.round(Number(v)).toString(16).padStart(2, "0")).join("").toUpperCase();
  };
  const sat = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r!, g!, b!);
    const min = Math.min(r!, g!, b!);
    return max === 0 ? 0 : (max - min) / max;
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1;
  };
  const tally = (m: Map<string, number>, k: string | null, w: number) => {
    if (k) m.set(k, (m.get(k) ?? 0) + w);
  };
  const top = (m: Map<string, number>, ok: (k: string) => boolean = () => true) => [...m].filter(([k]) => ok(k)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const meta: Record<string, string> = {};
  for (const el of document.querySelectorAll("meta[name], meta[property]")) {
    const k = (el.getAttribute("property") || el.getAttribute("name") || "").toLowerCase();
    const v = el.getAttribute("content");
    if (v && /^(description|og:|twitter:|theme-color|application-name|keywords)/.test(k)) meta[k] = v.slice(0, 500);
  }

  // Background: body, then html, else white.
  const bg = toHex(getComputedStyle(document.body).backgroundColor) ?? toHex(getComputedStyle(document.documentElement).backgroundColor) ?? "#FFFFFF";

  const textColors = new Map<string, number>();
  for (const el of document.querySelectorAll("h1, h2, h3, p, li")) {
    if (!visible(el)) continue;
    tally(textColors, toHex(getComputedStyle(el).color), (el.textContent ?? "").trim().length);
  }
  const ink = top(textColors) ?? (lum(bg) > 0.5 ? "#111111" : "#F5F5F5");
  const muted = top(textColors, (k) => k !== ink && sat(k) < 0.35 && Math.abs(lum(k) - lum(bg)) > 0.2) ?? "#71717A";

  const buttons = new Map<string, number>();
  for (const el of document.querySelectorAll("button, a, [role=button], input[type=submit]")) {
    const hint = `${el.tagName} ${el.getAttribute("class") ?? ""} ${el.getAttribute("role") ?? ""}`;
    if (!/BUTTON|INPUT|btn|button|cta|primary/i.test(hint) || !visible(el)) continue;
    const c = toHex(getComputedStyle(el).backgroundColor);
    if (!c || c === bg) continue;
    const r = el.getBoundingClientRect();
    tally(buttons, c, Math.min(r.width * r.height, 40_000) / 1000 + (/primary|cta/i.test(hint) ? 30 : 0));
  }
  const linkColors = new Map<string, number>();
  for (const el of document.querySelectorAll("a")) {
    if (!visible(el)) continue;
    tally(linkColors, toHex(getComputedStyle(el).color), 1);
  }
  const theme = meta["theme-color"] && /^#[0-9a-f]{6}$/i.test(meta["theme-color"]) ? meta["theme-color"].toUpperCase() : null;
  const primary = top(buttons, (k) => sat(k) > 0.25) ?? top(linkColors, (k) => sat(k) > 0.25) ?? theme ?? top(buttons) ?? ink;
  const accent = top(linkColors, (k) => sat(k) > 0.25 && k !== primary) ?? top(buttons, (k) => sat(k) > 0.25 && k !== primary) ?? theme ?? primary;

  // Logo candidates.
  const logos: InPage["logos"] = [];
  const hinted = (el: Element | null) => {
    for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) {
      const s = `${e.getAttribute("class") ?? ""} ${e.id} ${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("alt") ?? ""} ${e.getAttribute("src") ?? ""}`;
      if (/logo|brand/i.test(s)) return true;
    }
    return false;
  };
  const inHomeLink = (el: Element) => {
    const a = el.closest("a");
    if (!a) return false;
    try {
      const u = new URL(a.href, location.href);
      return u.origin === location.origin && (u.pathname === "/" || u.pathname === "");
    } catch {
      return false;
    }
  };
  const inHeader = (el: Element) => !!el.closest("header, nav, [class*=header], [class*=navbar]");
  // The home link in the header is the product's own mark. A "logo" class alone is not: integration strips and
  // customer walls are lists of other companies' logos, so a hint only counts inside the header.
  const logoScore = (el: Element) => {
    const home = inHomeLink(el);
    const header = inHeader(el);
    if (!home && !(header && hinted(el))) return 0;
    return (home ? 60 : 0) + (header ? 20 : 0) + (hinted(el) ? 20 : 0);
  };
  for (const svg of document.querySelectorAll("svg")) {
    if (!visible(svg)) continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 16 || r.height < 12) continue;
    const score = logoScore(svg);
    if (score < 40) continue;
    const clone = svg.cloneNode(true) as SVGElement;
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${Math.round(r.width)} ${Math.round(r.height)}`);
    // Inline SVGs often inherit currentColor from the page; bake it in.
    clone.setAttribute("color", getComputedStyle(svg).color);
    logos.push({ kind: "svg", score: score + 5, svg: clone.outerHTML });
  }
  for (const img of document.querySelectorAll("img")) {
    if (!visible(img) || !img.currentSrc) continue;
    const score = logoScore(img);
    if (score >= 40) logos.push({ kind: "url", score: score + (/\.svg(\?|$)/i.test(img.currentSrc) ? 5 : 0), url: img.currentSrc });
  }
  for (const l of document.querySelectorAll("link[rel]")) {
    const rel = (l.getAttribute("rel") ?? "").toLowerCase();
    const href = (l as HTMLLinkElement).href;
    if (!href) continue;
    if (/apple-touch-icon/.test(rel)) logos.push({ kind: "url", score: 35, url: href });
    else if (/\bicon\b/.test(rel)) {
      const svg = /svg/.test(l.getAttribute("type") ?? "") || /\.svg(\?|$)/i.test(href);
      const size = Number((l.getAttribute("sizes") ?? "").split("x")[0]) || 0;
      if (svg) logos.push({ kind: "url", score: 38, url: href });
      else if (size >= 64 || /\.png(\?|$)/i.test(href)) logos.push({ kind: "url", score: 25 + Math.min(size, 512) / 64, url: href });
    }
  }
  if (meta["og:image"]) logos.push({ kind: "url", score: 5, url: new URL(meta["og:image"], location.href).href });

  const links = [...document.querySelectorAll("a[href]")].slice(0, 400).map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").trim().slice(0, 80) }));
  const fontFamily = getComputedStyle(document.body).fontFamily.split(",")[0]?.replace(/["']/g, "").trim() || null;
  const text = (document.body.innerText || "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return {
    title: document.title,
    lang: document.documentElement.lang || null,
    meta,
    text,
    links,
    logos: logos.sort((a, b) => b.score - a.score).slice(0, 8),
    colors: { primary, accent, ink, bg, muted },
    font: fontFamily,
  };
}
/* c8 ignore stop */

async function load(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
}

async function fetchCapped(url: string): Promise<Buffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "autocm-prefill" } });
    if (!res.ok || !res.body) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > LOGO_MAX_BYTES) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > LOGO_MAX_BYTES) return null;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pickLogo(cands: InPage["logos"]): Promise<{ logo: Logo; source: string } | null> {
  for (const c of cands) {
    // Not a usable image type (e.g. .ico): try the next candidate.
    if (c.kind === "svg" && c.svg) {
      const logo = asLogo(Buffer.from(c.svg));
      if (logo) return { logo, source: "inline SVG in the page header" };
    }
    if (c.kind === "url" && c.url && /^https?:/.test(c.url)) {
      const buf = await fetchCapped(c.url);
      const logo = buf ? asLogo(buf) : null;
      if (logo) return { logo, source: c.url };
    }
  }
  return null;
}

/** Read the site: homepage plus up to MAX_PAGES relevant same-origin pages. */
export async function scrapeSite(rawUrl: string, step: Step = () => {}, browserIn?: Browser): Promise<SiteScrape> {
  const home = normalizeSiteUrl(rawUrl);
  const browser = browserIn ?? (await launchBrowser());
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 autocm-prefill" });
    // tsx/esbuild may wrap named functions in __name(); define it so the in-page function runs unchanged.
    await ctx.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
    const page = await ctx.newPage();
    step(`Loading ${home.host}`);
    await load(page, home.href);
    const finalHome = new URL(page.url());
    const first = await page.evaluate(extract);
    const screenshot = await page.screenshot({ type: "png" });
    const pages: PageText[] = [{ url: finalHome.href, title: first.title, description: first.meta.description ?? first.meta["og:description"] ?? "", text: first.text.slice(0, HOME_CHARS) }];
    for (const href of pickPages(first.links, finalHome)) {
      step(`Reading ${new URL(href).pathname}`);
      try {
        await load(page, href);
        if (new URL(page.url()).origin !== finalHome.origin) continue;
        const r = await page.evaluate(() => ({
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
          text: (document.body.innerText || "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"),
        }));
        pages.push({ url: page.url(), title: r.title, description: r.description, text: r.text.slice(0, PAGE_CHARS) });
      } catch (e) {
        log.warn({ url: href, err: (e as Error).message }, "prefill: page failed");
      }
    }
    step("Picking the logo");
    const logo = await pickLogo(first.logos);
    await ctx.close();
    return {
      url: finalHome.href,
      origin: finalHome.origin,
      language: first.lang ? first.lang.slice(0, 2).toLowerCase() : null,
      siteName: first.meta["og:site_name"] ?? first.meta["application-name"] ?? null,
      font: first.font,
      meta: first.meta,
      pages,
      colors: first.colors,
      logo: logo?.logo ?? null,
      logoSource: logo?.source ?? null,
      screenshot,
    };
  } finally {
    if (!browserIn) await browser.close();
  }
}

// ---------- LLM draft ----------

export const DraftSchema = z.object({
  name: z.string().describe("Product name as the site writes it"),
  one_liner: z.string().describe("One sentence: what it does and for whom, in plain words"),
  audience: z.string().describe("Who buys and uses it, concretely (roles, company size, region if stated)"),
  language: z.string().describe("ISO 639-1 code of the language posts should be written in (the site's language)"),
  timezone: z.string().describe("IANA time zone where most of the audience is, e.g. America/New_York"),
  voice: z.object({
    rules: z
      .array(z.string())
      .describe("4-8 concrete voice rules for X posts, matching the site's tone: register, humor, vocabulary, what may be claimed. Not post structure (the marketer decides that per post)"),
    banned_phrases: z.array(z.string()).describe("Hype words and cliches to never use"),
    example_posts: z.array(z.string()).describe("3-6 example posts (<=280 chars) using only facts from the site"),
  }),
  pillars: z
    .array(z.object({ id: z.string().describe("kebab-case id"), description: z.string(), weight: z.number().describe("relative weight 1-3") }))
    .describe("3-5 content pillars"),
  format_mix: z.object({ text: z.number(), image: z.number(), video: z.number() }).describe("Relative share of text/image/video posts"),
  brand_guidelines: z
    .array(z.string())
    .describe(
      "5-8 rules of a design manual for the images of the X account, read from the attached screenshot of the homepage: " +
        "the look and mood, type (weights, case, tracking), how color is used, shapes, corners, spacing, recurring motifs, " +
        "and what would feel off-brand. Concrete enough for a designer who never saw the site.",
    ),
  cta_url: z.string().describe("Best page to send people to (trial/pricing/home), on the same site"),
  knowledge_markdown: z
    .string()
    .describe(
      "Markdown knowledge file: what the product is, who it is for, features, pricing and plans as stated, integrations, " +
        "differentiators, and a final '## Facts you must not claim' section. Only facts from the pages.",
    ),
});
export type DraftOut = z.infer<typeof DraftSchema>;

const FACTS_HEADING = /^#{1,3}\s*facts you must not claim/im;

function prompt(s: SiteScrape): string {
  const pages = s.pages.map((p) => `### ${p.url}\nTitle: ${p.title}\n${p.description ? `Description: ${p.description}\n` : ""}\n${p.text}`).join("\n\n");
  const meta = Object.entries(s.meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `You are setting up an autonomous X (Twitter) account for a product. Below is the visible text of its website,
and the attached image is a screenshot of its homepage. Draft the product profile the posting pipeline will use.

Hard rules:
- Use only facts stated on these pages. Do not invent customers, logos, quotes, metrics, percentages, time saved, integrations, features or prices.
- If something is not on the pages (e.g. pricing), say so in the knowledge file instead of guessing.
- knowledge_markdown must end with a "## Facts you must not claim" section listing things the posts must never claim:
  invented customers or testimonials, metrics not on the site, features or integrations not listed, anything the site leaves unclear.
- Voice rules must be specific to this product and its audience, and keep claims factual.
- Pillar ids are short kebab-case words (e.g. pain, product, how-to, build-in-public).
- brand_guidelines describe what you see in the screenshot, not generic advice.

Site: ${s.url}
Language attribute: ${s.language ?? "unknown"}
Meta tags:
${meta || "(none)"}

Pages:
${pages}`;
}

function cleanPillars(p: DraftOut["pillars"]): { id: string; description: string; weight: number }[] {
  const seen = new Set<string>();
  const out: { id: string; description: string; weight: number }[] = [];
  for (const x of p) {
    let id = slugify(x.id) || "pillar";
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    out.push({ id, description: x.description.trim(), weight: Math.min(5, Math.max(1, Math.round(Number(x.weight) || 1))) });
  }
  return out.slice(0, 6);
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Build the form draft from a scrape and the LLM output. Pure, so it is easy to test. */
export function buildDraft(s: SiteScrape, d: DraftOut): ProductDraft {
  const notes: string[] = [];
  let cta = s.url;
  try {
    const u = new URL(d.cta_url, s.url);
    if (u.origin === s.origin) cta = u.href;
  } catch {
    // keep the homepage
  }
  let knowledge = d.knowledge_markdown.trim();
  if (!FACTS_HEADING.test(knowledge)) {
    knowledge +=
      "\n\n## Facts you must not claim\n\n- Customers, testimonials or logos that are not on the website.\n- Metrics, percentages or time saved that the website does not state.\n- Features, integrations or prices that are not listed on the website.";
  }
  const mix = d.format_mix;
  const mixOk = [mix.text, mix.image, mix.video].every((n) => Number.isFinite(n) && n >= 0) && mix.text + mix.image + mix.video > 0;
  const tz = validTz(d.timezone) ? d.timezone : "America/New_York";
  if (tz !== d.timezone) notes.push(`The suggested time zone "${d.timezone}" is not valid; using America/New_York.`);
  if (s.font && !/^(geist|system-ui|-apple-system|ui-sans-serif|sans-serif|arial|helvetica|segoe ui|blinkmacsystemfont)$/i.test(s.font)) {
    notes.push(`The site uses ${s.font}; images use Geist.`);
  }
  if (!s.logo) notes.push("No logo found on the site; the X avatar is used.");
  else notes.push(`Logo from ${s.logoSource}.`);

  const config: Record<string, unknown> = {
    name: d.name.trim() || s.siteName || new URL(s.url).hostname,
    url: s.url,
    enabled: true,
    language: /^[a-z]{2}$/.test(d.language) ? d.language : (s.language ?? "en"),
    timezone: tz,
    one_liner: d.one_liner.trim(),
    audience: d.audience.trim(),
    voice: {
      rules: d.voice.rules.map((r) => r.trim()).filter(Boolean),
      banned_phrases: d.voice.banned_phrases.map((r) => r.trim()).filter(Boolean),
      example_posts: d.voice.example_posts.map((r) => r.trim()).filter(Boolean),
    },
    pillars: cleanPillars(d.pillars),
    format_mix: mixOk ? mix : { text: 0.4, image: 0.4, video: 0.2 },
    cadence: defaultCadence(),
    brand: {
      colors: { ...s.colors },
      fonts: { sans: "Geist", mono: "Geist Mono", files: [] },
      logo: "",
      guidelines: d.brand_guidelines.map((g) => g.trim()).filter(Boolean),
      reference: "",
    },
    assets: { clips: [], screens: [] },
    links: { cta_url: cta, max_link_ratio: 0.34 },
    hashtags: { max_per_post: 1 },
  };
  return {
    config,
    knowledge: [{ name: "00-overview.md", content: `${knowledge}\n` }],
    logo: s.logo,
    reference: s.screenshot,
    sources: s.pages.map((p) => p.url),
    notes,
  };
}

/** Scrape the site and ask the LLM for a draft. */
export async function draftFromWebsite(url: string, step: Step = () => {}): Promise<ProductDraft> {
  const scrape = await scrapeSite(url, step);
  if (scrape.pages.every((p) => p.text.length < 40)) throw new Error("The site has almost no readable text (is it a single-page app that needs a login?)");
  step("Writing the draft");
  const shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "autocm-prefill-")), "home.png");
  fs.writeFileSync(shot, scrape.screenshot);
  try {
    const out = await callJson(DraftSchema, prompt(scrape), { stage: PREFILL_STAGE, model: "sonnet", timeoutMs: 240_000, images: [shot] });
    return buildDraft(scrape, out);
  } finally {
    fs.rmSync(path.dirname(shot), { recursive: true, force: true });
  }
}
