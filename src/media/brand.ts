// Brand tokens for renderers, resolved from product.yaml + products/<slug>/assets.
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
  colors: { bg: string; fg: string; muted: string; hl: string; primary: string; accent: string; ink: string; paper: string };
  sansStack: string;
  monoStack: string;
  /** Font files to register (product fonts first, bundled Geist fallback last). */
  fonts: FontFile[];
  /** Product-provided fonts.css (absolute path), used as-is instead of generated @font-face for product files. */
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

function logoDataUri(file: string, theme: Theme): string | null {
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file).toLowerCase();
  if (ext === ".svg") {
    const svg = svgForTheme(fs.readFileSync(file, "utf8"), theme);
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

export function resolveBrand(product: Product, theme: Theme = "dark"): Brand {
  const c = product.config;
  const col = c.brand.colors;
  const notes: string[] = [];
  const muted = col.muted ?? "#71717A";
  const colors =
    theme === "dark"
      ? { bg: col.ink, fg: col.bg, muted, hl: col.accent, primary: col.primary, accent: col.accent, ink: col.ink, paper: col.bg }
      : { bg: col.bg, fg: col.ink, muted, hl: col.primary, primary: col.primary, accent: col.accent, ink: col.ink, paper: col.bg };

  const sans = c.brand.fonts.sans;
  const mono = c.brand.fonts.mono;
  const fonts: FontFile[] = [];
  const cssPath = path.join(product.dir, "assets", "fonts", "fonts.css");
  const fontsCss = fs.existsSync(cssPath) ? cssPath : null;
  if (!fontsCss) {
    for (const rel of c.brand.fonts.files) {
      const abs = productPath(product, rel);
      if (fs.existsSync(abs)) fonts.push(fontFaceFromFile(abs, sans, mono));
      else notes.push(`font file missing: ${rel}`);
    }
  }
  if (!fontsCss && fonts.length === 0) notes.push(`no ${sans} font files in product; using bundled fallback`);
  fonts.push(...bundledFallbackFonts());

  const logo = logoDataUri(productPath(product, c.brand.logo), theme);
  if (!logo) notes.push(`logo missing: ${c.brand.logo}`);

  return {
    name: c.name,
    url: c.url,
    host: hostOf(c.url),
    theme,
    colors,
    sansStack: `"${sans}", "autocm-sans", ui-sans-serif, system-ui, sans-serif`,
    monoStack: `${mono ? `"${mono}", ` : ""}"autocm-mono", ui-monospace, monospace`,
    fonts,
    fontsCss,
    logo,
    notes,
  };
}

/** :root custom properties shared by templates (and mirrored in Remotion props). */
export function brandCssVars(b: Brand): string {
  return `:root{--bg:${b.colors.bg};--fg:${b.colors.fg};--muted:${b.colors.muted};--hl:${b.colors.hl};--primary:${b.colors.primary};--accent:${b.colors.accent};--sans:${b.sansStack};--mono:${b.monoStack};color-scheme:${b.theme};}`;
}

export function fontFaceCss(fonts: FontFile[], urlFor: (f: FontFile, i: number) => string): string {
  return fonts
    .map(
      (f, i) =>
        `@font-face{font-family:"${f.family}";src:url("${urlFor(f, i)}") format("${f.file.endsWith(".woff2") ? "woff2" : f.file.endsWith(".woff") ? "woff" : "truetype"}");font-weight:${f.weight};font-style:${f.style};font-display:block;}`,
    )
    .join("\n");
}
