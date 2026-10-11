import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getXAccount } from "./db/index.ts";
import { PRODUCTS_DIR, sessionDir } from "./paths.ts";
import { ProductConfig, type Product, type XAccount } from "./types.ts";

export function listProductSlugs(): string[] {
  if (!fs.existsSync(PRODUCTS_DIR)) return [];
  return fs
    .readdirSync(PRODUCTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PRODUCTS_DIR, d.name, "product.yaml")))
    .map((d) => d.name)
    .sort();
}

/** The product's connected X account: a DB row plus its browser profile on disk. */
function readXAccount(slug: string): XAccount | null {
  const account = getXAccount(slug);
  return account && fs.existsSync(sessionDir(slug)) ? account : null;
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
  return { config: parsed.data, dir, knowledge: readKnowledge(dir), xAccount: readXAccount(slug) };
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
  must(c.brand.reference, "brand reference screenshot");
  c.brand.fonts.files.forEach((f) => must(f, "font"));
  c.assets.clips.forEach((cl) => must(cl.path, `clip ${cl.id}`));
  c.assets.screens.forEach((s) => must(s.path, `screen ${s.id}`));
  if (!product.knowledge) problems.push("knowledge/ has no .md files");
  return problems;
}
