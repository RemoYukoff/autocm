import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import { env } from "./env.ts";
import { PRODUCTS_DIR } from "./paths.ts";
import { ProductConfig, type Capabilities, type Product, type XCreds } from "./types.ts";

export function listProductSlugs(): string[] {
  if (!fs.existsSync(PRODUCTS_DIR)) return [];
  return fs
    .readdirSync(PRODUCTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PRODUCTS_DIR, d.name, "product.yaml")))
    .map((d) => d.name)
    .sort();
}

function readXCreds(dir: string): XCreds | null {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return null;
  const vars = dotenv.parse(fs.readFileSync(file));
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = vars;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) return null;
  return { appKey: X_API_KEY, appSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET };
}

function readKnowledge(dir: string): string {
  const kdir = path.join(dir, "knowledge");
  if (!fs.existsSync(kdir)) return "";
  return fs
    .readdirSync(kdir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `<!-- ${f} -->\n${fs.readFileSync(path.join(kdir, f), "utf8").trim()}`)
    .join("\n\n");
}

export function loadProduct(slug: string): Product {
  const dir = path.join(PRODUCTS_DIR, slug);
  const file = path.join(dir, "product.yaml");
  if (!fs.existsSync(file)) throw new Error(`Unknown product "${slug}" (no ${file})`);
  const parsed = ProductConfig.safeParse(YAML.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${parsed.error.message}`);
  if (parsed.data.slug !== slug) throw new Error(`${file}: slug "${parsed.data.slug}" must match folder "${slug}"`);
  return { config: parsed.data, dir, knowledge: readKnowledge(dir), xCreds: readXCreds(dir) };
}

export function loadProducts(): Product[] {
  return listProductSlugs().map(loadProduct);
}

/** Resolve a path declared in product.yaml (relative to the product folder). */
export function productPath(product: Product, rel: string): string {
  return path.resolve(product.dir, rel);
}

/** Problems that make a product unusable at runtime (missing files etc.). */
export function validateProductFiles(product: Product): string[] {
  const c = product.config;
  const problems: string[] = [];
  const must = (rel: string, what: string) => {
    if (!fs.existsSync(productPath(product, rel))) problems.push(`${what} not found: ${rel}`);
  };
  must(c.brand.logo, "logo");
  c.brand.fonts.files.forEach((f) => must(f, "font"));
  c.assets.clips.forEach((cl) => must(cl.path, `clip ${cl.id}`));
  c.assets.screens.forEach((s) => must(s.path, `screen ${s.id}`));
  if (!product.knowledge) problems.push("knowledge/ has no .md files");
  return problems;
}

export function capabilitiesFor(product: Product): Capabilities {
  return {
    template: true,
    remotion: true,
    clip: product.config.assets.clips.length > 0,
    ai_image: Boolean(env.openaiKey || env.geminiKey || env.falKey),
    ai_video: Boolean(env.falKey) && env.aiVideo,
    live: env.mode === "live" && product.xCreds !== null,
  };
}
