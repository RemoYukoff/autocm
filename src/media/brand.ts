// Brand files for designs and video edits: fonts and logos, resolved from product.yaml + products/<slug>/assets.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { productPath } from "../core/config.ts";
import type { Product } from "../core/types.ts";

export type Theme = "dark" | "light";

export interface FontFile {
  family: string;
  /** Absolute path on disk */
  file: string;
  weight: string;
  style: "normal" | "italic";
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

export function fontFaceCss(fonts: FontFile[], urlFor: (f: FontFile, i: number) => string): string {
  return fonts
    .map(
      (f, i) =>
        `@font-face{font-family:"${f.family}";src:url("${urlFor(f, i)}") format("${f.file.endsWith(".woff2") ? "woff2" : f.file.endsWith(".woff") ? "woff" : "truetype"}");font-weight:${f.weight};font-style:${f.style};font-display:block;}`,
    )
    .join("\n");
}
