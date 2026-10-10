// Write a new product folder (products/<slug>/) from a website draft: product.yaml, knowledge/*.md, logo and fonts.
// The config is validated before anything is written; the folder is built in a temp dir and renamed into place,
// so the scheduler never reads a half-written product.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import YAML from "yaml";
import { PRODUCTS_DIR } from "../core/paths.ts";
import { ProductConfig } from "../core/types.ts";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const KNOWLEDGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/;

export class ProductWriteError extends Error {}

export interface NewProduct {
  /** product.yaml without slug, brand.logo and brand.fonts.files: those are filled here. */
  config: Record<string, unknown>;
  knowledge: { name: string; content: string }[];
  logo: { data: Buffer; ext: string };
}

export function slugify(name: string): string {
  return String(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function productDir(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new ProductWriteError(`bad product slug "${slug}"`);
  return path.join(PRODUCTS_DIR, slug);
}

// ---------- fonts: every new product renders with Geist ----------

const require = createRequire(import.meta.url);

const GEIST_FILES = [
  ["geist-sans", "Geist-Regular.woff2", 400],
  ["geist-sans", "Geist-Medium.woff2", 500],
  ["geist-sans", "Geist-SemiBold.woff2", 600],
  ["geist-sans", "Geist-Bold.woff2", 700],
  ["geist-mono", "GeistMono-Regular.woff2", 400],
  ["geist-mono", "GeistMono-Medium.woff2", 500],
] as const;

function geistDir(): string | null {
  try {
    const dir = path.join(path.dirname(require.resolve("geist/font")), "fonts");
    return fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** Copy Geist + Geist Mono woff2 (and fonts.css, license) into `<dir>/assets/fonts/`. Returns the file list for product.yaml. */
function copyGeistFonts(dir: string): string[] {
  const src = geistDir();
  if (!src) return [];
  const out = path.join(dir, "assets", "fonts");
  fs.mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const css: string[] = ["/* Geist and Geist Mono (SIL Open Font License 1.1, see LICENSE-OFL.txt). Copied by autocm. */"];
  for (const [sub, name, weight] of GEIST_FILES) {
    const from = path.join(src, sub, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(out, name));
    files.push(`assets/fonts/${name}`);
    const family = sub === "geist-mono" ? "Geist Mono" : "Geist";
    css.push(`@font-face {\n  font-family: "${family}";\n  src: url("${name}") format("woff2");\n  font-weight: ${weight};\n  font-style: normal;\n  font-display: block;\n}`);
  }
  fs.writeFileSync(path.join(out, "fonts.css"), css.join("\n") + "\n");
  const license = path.join(src, "..", "..", "LICENSE.txt");
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(out, "LICENSE-OFL.txt"));
  return files;
}

// ---------- write ----------

/** Create products/<slug>/. Throws ProductWriteError when the folder exists or the config is not valid. */
export function writeProduct(slug: string, p: NewProduct): void {
  const dir = productDir(slug);
  if (fs.existsSync(dir)) throw new ProductWriteError(`products/${slug} already exists`);
  const knowledge = p.knowledge.filter((k) => KNOWLEDGE_NAME_RE.test(k.name) && k.content.trim());
  if (!knowledge.length) throw new ProductWriteError("the draft has no knowledge to post from");

  fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
  const tmp = path.join(PRODUCTS_DIR, `.new-${slug}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(tmp, "knowledge"), { recursive: true });
  try {
    const logo = `assets/logo${p.logo.ext}`;
    fs.mkdirSync(path.join(tmp, "assets"), { recursive: true });
    fs.writeFileSync(path.join(tmp, logo), p.logo.data);
    const brand = (p.config.brand ?? {}) as Record<string, unknown>;
    const fonts = (brand.fonts ?? {}) as Record<string, unknown>;
    const parsed = ProductConfig.safeParse({
      ...p.config,
      slug,
      brand: { ...brand, logo, fonts: { sans: "Geist", mono: "Geist Mono", ...fonts, files: copyGeistFonts(tmp) } },
    });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`);
      throw new ProductWriteError(`invalid product config (${issues.slice(0, 5).join("; ")})`);
    }
    for (const k of knowledge) fs.writeFileSync(path.join(tmp, "knowledge", k.name), k.content.trimEnd() + "\n");
    fs.writeFileSync(path.join(tmp, "product.yaml"), `# ${parsed.data.name}. Written by autocm from ${parsed.data.url}.\n${YAML.stringify(parsed.data, { lineWidth: 0 })}`);
    if (fs.existsSync(dir)) throw new ProductWriteError(`products/${slug} already exists`);
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
