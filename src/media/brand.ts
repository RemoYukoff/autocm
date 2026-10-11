// Brand tokens for renderers (designs and Remotion), resolved from product.yaml + products/<slug>/assets.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { productPath } from "../core/config.ts";
import type { Product } from "../core/types.ts";
import { hostOf } from "./copy.ts";

export type Theme = "dark" | "light";

export interface FontFile {
  family: string;
  /** Absolute path on disk */
  file: string;
  weight: string;
  style: "normal" | "italic";
}

export interface Brand {
  name: string;
  url: string;
  host: string;
  theme: Theme;
  /** hl and primary always contrast with bg; onHl is the text color on an hl-filled block. */
  colors: { bg: string; fg: string; muted: string; hl: string; onHl: string; primary: string; accent: string; ink: string; paper: string };
  sansStack: string;
  monoStack: string;
  /** Font files to register (product fonts first, bundled Geist fallback last). */
  fonts: FontFile[];
  /** Product-provided fonts.css (absolute path), imported by designs in addition to generated @font-face rules. */
  fontsCss: string | null;
  /** data: URI of the logo, recolored for the theme when it is an SVG with a dark-scheme block. */
  logo: string | null;
  notes: string[];
}

const require = createRequire(import.meta.url);

const WEIGHTS: [RegExp, string][] = [
  [/thin|hairline/i, "100"],
  [/extra-?light|ultra-?light/i, "200"],
  [/light/i, "300"],
  [/medium/i, "500"],
  [/semi-?bold|demi-?bold/i, "600"],
  [/extra-?bold|ultra-?bold/i, "800"],
  [/black|heavy/i, "900"],
  [/bold/i, "700"],
  [/variable|\[wght\]|-vf\b/i, "100 900"],
];

export function fontFaceFromFile(file: string, sans: string, mono?: string): FontFile {
  const base = path.basename(file).replace(/\.(woff2?|ttf|otf)$/i, "");
  const isMono = /mono/i.test(base) || (mono ? base.toLowerCase().includes(mono.toLowerCase().replace(/\s+/g, "")) : false);
  const weight = WEIGHTS.find(([re]) => re.test(base))?.[1] ?? "400";
  return { family: isMono && mono ? mono : sans, file, weight, style: /italic/i.test(base) ? "italic" : "normal" };
}

function bundledFallbackFonts(): FontFile[] {
  try {
    // geist only exports ./font*; dist/font.js sits next to dist/fonts/.
    const dir = path.join(path.dirname(require.resolve("geist/font")), "fonts");
    const sans = path.join(dir, "geist-sans", "Geist-Variable.woff2");
    const mono = path.join(dir, "geist-mono", "GeistMono-Variable.woff2");
    const out: FontFile[] = [];
    if (fs.existsSync(sans)) out.push({ family: "autocm-sans", file: sans, weight: "100 900", style: "normal" });
    if (fs.existsSync(mono)) out.push({ family: "autocm-mono", file: mono, weight: "100 900", style: "normal" });
    return out;
  } catch {
    return [];
  }
}

/**
 * Force an SVG's own `prefers-color-scheme: dark` block on (dark theme) or off (light theme).
 * Needed because an <img>/Remotion frame does not know which background the logo sits on.
 */
export function svgForTheme(svg: string, theme: Theme): string {
  return svg.replace(/prefers-color-scheme\s*:\s*dark/gi, theme === "dark" ? "min-width:0px" : "max-width:0px");
}

/** Logo bytes for a background of the given theme (an SVG's dark-scheme block forced on or off). */
export function logoFile(product: Product, theme: Theme): { body: Buffer; ext: string } | null {
  const file = productPath(product, product.config.brand.logo);
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file).toLowerCase();
  if (ext === ".svg") return { body: Buffer.from(svgForTheme(fs.readFileSync(file, "utf8"), theme)), ext };
  return { body: fs.readFileSync(file), ext };
}

function logoDataUri(product: Product, theme: Theme): string | null {
  const logo = logoFile(product, theme);
  if (!logo) return null;
  const mime = logo.ext === ".svg" ? "image/svg+xml" : logo.ext === ".png" ? "image/png" : logo.ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${logo.body.toString("base64")}`;
}

/** Product font files (product.yaml first, the bundled Geist fallback last) and the product's fonts.css, if any. */
export function resolveFonts(product: Product): { fonts: FontFile[]; fontsCss: string | null; notes: string[] } {
  const { sans, mono, files } = product.config.brand.fonts;
  const notes: string[] = [];
  const fonts: FontFile[] = [];
  const cssPath = path.join(product.dir, "assets", "fonts", "fonts.css");
  const fontsCss = fs.existsSync(cssPath) ? cssPath : null;
  // Listed files are always registered (Remotion only sees these); designs additionally @import fonts.css.
  for (const rel of files) {
    const abs = productPath(product, rel);
    if (fs.existsSync(abs)) fonts.push(fontFaceFromFile(abs, sans, mono));
    else notes.push(`font file missing: ${rel}`);
  }
  fonts.push(...bundledFallbackFonts());
  return { fonts, fontsCss, notes };
}

export function resolveBrand(product: Product, theme: Theme = "dark"): Brand {
  const c = product.config;
  const col = c.brand.colors;
  const muted = col.muted ?? "#71717A";
  const bg = theme === "dark" ? col.ink : col.bg;
  const fg = theme === "dark" ? col.bg : col.ink;
  // A monochrome site gives accent == primary == ink, which vanishes on a dark background: brand colors that do
  // not stand out from the background give way to the foreground.
  const pop = (c: string) => (contrast(c, bg) >= 2.5 ? c : fg);
  const hl = pop(theme === "dark" ? col.accent : col.primary);
  const colors = { bg, fg, muted, hl, onHl: contrast(bg, hl) >= contrast(fg, hl) ? bg : fg, primary: pop(col.primary), accent: pop(col.accent), ink: col.ink, paper: col.bg };

  const { fonts, fontsCss, notes } = resolveFonts(product);
  const logo = logoDataUri(product, theme);
  if (!logo) notes.push(`logo missing: ${c.brand.logo}`);

  return {
    name: c.name,
    url: c.url,
    host: hostOf(c.url),
    theme,
    colors,
    sansStack: `"${c.brand.fonts.sans}", "autocm-sans", ui-sans-serif, system-ui, sans-serif`,
    monoStack: `${c.brand.fonts.mono ? `"${c.brand.fonts.mono}", ` : ""}"autocm-mono", ui-monospace, monospace`,
    fonts,
    fontsCss,
    logo,
    notes,
  };
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

export function fontFaceCss(fonts: FontFile[], urlFor: (f: FontFile, i: number) => string): string {
  return fonts
    .map(
      (f, i) =>
        `@font-face{font-family:"${f.family}";src:url("${urlFor(f, i)}") format("${f.file.endsWith(".woff2") ? "woff2" : f.file.endsWith(".woff") ? "woff" : "truetype"}");font-weight:${f.weight};font-style:${f.style};font-display:block;}`,
    )
    .join("\n");
}
