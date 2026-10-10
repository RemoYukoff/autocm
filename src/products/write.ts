// Create and edit products from the dashboard: products/<slug>/product.yaml, knowledge/*.md and assets/.
// Everything is validated before the first byte is written; a new product is built in a temp folder and renamed
// into place, and product.yaml is written last (atomically) so the scheduler never reads a half-saved product.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PRODUCTS_DIR } from "../core/paths.ts";
import { ProductConfig } from "../core/types.ts";
import { dropUpload, getUpload, type StagedUpload, type UploadKind } from "./uploads.ts";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const KNOWLEDGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.md$/;
export const ASSET_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_KNOWLEDGE_BYTES = 256 * 1024;
const MAX_KNOWLEDGE_FILES = 40;

export type FieldErrors = Record<string, string>;

export class ProductWriteError extends Error {
  readonly status: 400 | 404 | 409;
  readonly errors: FieldErrors;
  constructor(status: ProductWriteError["status"], message: string, errors: FieldErrors = {}) {
    super(message);
    this.name = "ProductWriteError";
    this.status = status;
    this.errors = errors;
  }
}

/** What the dashboard form sends. Assets in `config.assets` either keep a `path` or bring a staged `upload` token. */
export const ProductInput = z.object({
  config: z.record(z.string(), z.unknown()),
  knowledge: z.array(z.object({ name: z.string(), content: z.string() })).max(MAX_KNOWLEDGE_FILES).default([]),
  knowledge_delete: z.array(z.string()).default([]),
  logo_upload: z.string().nullish(),
  font_uploads: z.array(z.string()).max(12).default([]),
});
export type ProductInput = z.input<typeof ProductInput>;

export interface SaveResult {
  slug: string;
  created: boolean;
  notes: string[];
}

export interface KnowledgeFile {
  name: string;
  content: string;
}

export interface ProductForEdit {
  slug: string;
  /** product.yaml as written (not defaulted), so an invalid file can still be opened and fixed. */
  config: Record<string, unknown>;
  knowledge: KnowledgeFile[];
  /** Schema problems of the file on disk, by field path. */
  errors: FieldErrors;
}

// ---------- helpers ----------

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
  if (!SLUG_RE.test(slug)) throw new ProductWriteError(400, `bad product slug "${slug}"`);
  return path.join(PRODUCTS_DIR, slug);
}

/**
 * Resolve a path relative to a product folder, or null when it is absolute, climbs out (`..`), or resolves
 * (through symlinks) outside the folder.
 */
export function insideProduct(dir: string, rel: unknown): string | null {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === "..")) return null;
  const base = path.resolve(dir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) return null;
  if (fs.existsSync(abs)) {
    try {
      if (!fs.realpathSync(abs).startsWith(fs.realpathSync(base) + path.sep)) return null;
    } catch {
      return null;
    }
  }
  return abs;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Drop "" from optional-looking places so the schema sees "missing" rather than "empty". */
function dropEmpty(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropEmpty);
  if (!isObj(v)) return typeof v === "string" ? v.trim() : v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    const c = dropEmpty(val);
    if (c === "" || c === null || c === undefined) continue;
    out[k] = c;
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function issueMessage(i: z.core.$ZodIssue): string {
  if (i.code === "invalid_type" && /received undefined/.test(i.message)) return "Required";
  return i.message.replace(/^Invalid input: /, "");
}

function addError(errors: FieldErrors, key: string, msg: string): void {
  if (!errors[key]) errors[key] = msg;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** `assets/<sub>/<stem><ext>`, adding -2, -3... when the name is taken in `dir`. */
function freeName(dir: string, sub: string, stem: string, ext: string, taken: Set<string>): string {
  for (let n = 1; n < 1000; n++) {
    const rel = path.posix.join("assets", sub, `${stem}${n === 1 ? "" : `-${n}`}${ext}`);
    if (!taken.has(rel) && !fs.existsSync(path.join(dir, rel))) {
      taken.add(rel);
      return rel;
    }
  }
  throw new ProductWriteError(409, `no free file name for ${stem}${ext}`);
}

// ---------- fonts ----------

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
export function copyGeistFonts(dir: string): string[] {
  const src = geistDir();
  if (!src) return [];
  const out = path.join(dir, "assets", "fonts");
  fs.mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const css: string[] = ["/* Geist and Geist Mono (SIL Open Font License 1.1, see LICENSE-OFL.txt). Copied by the autocm dashboard. */"];
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

// ---------- read ----------

function readKnowledgeFiles(dir: string): KnowledgeFile[] {
  const kdir = path.join(dir, "knowledge");
  if (!fs.existsSync(kdir)) return [];
  return fs
    .readdirSync(kdir)
    .filter((f) => KNOWLEDGE_NAME_RE.test(f) && fs.statSync(path.join(kdir, f)).isFile())
    .sort()
    .map((name) => ({ name, content: fs.readFileSync(path.join(kdir, name), "utf8") }));
}

export function schemaErrors(config: unknown): FieldErrors {
  const errors: FieldErrors = {};
  const r = ProductConfig.safeParse(config);
  if (!r.success) for (const i of r.error.issues) addError(errors, i.path.map(String).join(".") || "config", issueMessage(i));
  return errors;
}

/** The product as the edit form needs it. */
export function readProductForEdit(slug: string): ProductForEdit {
  const dir = productDir(slug);
  const file = path.join(dir, "product.yaml");
  if (!fs.existsSync(file)) throw new ProductWriteError(404, `unknown product "${slug}"`);
  let config: Record<string, unknown> = {};
  const errors: FieldErrors = {};
  try {
    const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (isObj(parsed)) config = parsed;
    else errors.config = "product.yaml is not a mapping";
  } catch (e) {
    errors.config = `product.yaml does not parse: ${(e as Error).message.split("\n")[0]}`;
  }
  if (!errors.config) Object.assign(errors, schemaErrors(config));
  return { slug, config, knowledge: readKnowledgeFiles(dir), errors };
}

// ---------- validate + plan ----------

interface Copy {
  upload: StagedUpload;
  rel: string;
}

interface Plan {
  config: ProductConfig;
  copies: Copy[];
  knowledge: KnowledgeFile[];
  knowledgeDelete: string[];
  copyGeist: boolean;
  notes: string[];
}

function planSave(slug: string, dir: string, body: unknown, create: boolean): Plan {
  const parsedBody = ProductInput.safeParse(body);
  if (!parsedBody.success) throw new ProductWriteError(400, `bad request: ${parsedBody.error.issues[0]?.message ?? "invalid body"}`);
  const input = parsedBody.data;
  const errors: FieldErrors = {};
  const notes: string[] = [];
  const copies: Copy[] = [];
  const taken = new Set<string>();
  const cfg = dropEmpty(input.config) as Record<string, unknown>;
  cfg.slug = slug;

  // Strings the schema allows empty but a post cannot do without.
  for (const key of ["name", "one_liner", "audience"]) if (typeof cfg[key] !== "string" || !cfg[key]) addError(errors, key, "Required");
  if (typeof cfg.timezone === "string" && !validTimezone(cfg.timezone)) addError(errors, "timezone", `Unknown time zone "${cfg.timezone}"`);

  const brand = isObj(cfg.brand) ? cfg.brand : (cfg.brand = {});
  const colors = isObj(brand.colors) ? brand.colors : {};
  for (const [k, v] of Object.entries(colors)) {
    if (typeof v === "string" && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) addError(errors, `brand.colors.${k}`, "Use a hex color like #4F46E5");
  }

  // Logo: a staged upload wins; otherwise an existing file inside the product folder.
  if (input.logo_upload) {
    const up = getUpload(input.logo_upload, "logo");
    if (!up) addError(errors, "brand.logo", "The uploaded logo expired; upload it again");
    else {
      const rel = freeName(dir, "", "logo", up.ext, taken);
      copies.push({ upload: up, rel });
      brand.logo = rel;
    }
  } else if (!brand.logo) {
    addError(errors, "brand.logo", "Upload a logo (or fill from website)");
  } else if (create || !insideProduct(dir, brand.logo) || !fs.existsSync(insideProduct(dir, brand.logo)!)) {
    addError(errors, "brand.logo", "Logo file not found in the product folder; upload it again");
  }

  // Fonts: existing files must live in the folder; uploads are added; Geist is copied for new products.
  const fonts = isObj(brand.fonts) ? brand.fonts : (brand.fonts = {});
  const files = Array.isArray(fonts.files) ? fonts.files : [];
  files.forEach((f, i) => {
    const abs = create ? null : insideProduct(dir, f);
    if (!abs || !fs.existsSync(abs)) addError(errors, `brand.fonts.files.${i}`, `Font file not found: ${String(f)}`);
  });
  for (const token of input.font_uploads) {
    const up = getUpload(token, "font");
    if (!up) {
      addError(errors, "brand.fonts.files", "An uploaded font expired; upload it again");
      continue;
    }
    const rel = freeName(dir, "fonts", up.name.replace(/\.woff2$/, ""), ".woff2", taken);
    copies.push({ upload: up, rel });
    files.push(rel);
  }
  if (!fonts.sans) fonts.sans = "Geist";
  let copyGeist = false;
  if (create && files.length === 0 && /^geist$/i.test(String(fonts.sans))) {
    copyGeist = true;
    fonts.mono ??= "Geist Mono";
  } else if (files.length === 0 && !/^geist$/i.test(String(fonts.sans))) {
    notes.push(`No font files for ${String(fonts.sans)}: images and videos fall back to Geist until you upload woff2 files.`);
  }
  fonts.files = files;

  // Screens and clips: { id, description, path } kept, or { id, description, upload } staged.
  const assets = isObj(cfg.assets) ? cfg.assets : (cfg.assets = {});
  for (const [key, kind, sub] of [["screens", "screen", "screens"], ["clips", "clip", "clips"]] as const) {
    const list = Array.isArray(assets[key]) ? (assets[key] as unknown[]) : [];
    const ids = new Set<string>();
    assets[key] = list.map((raw, i) => {
      const item = isObj(raw) ? { ...raw } : {};
      const at = `assets.${key}.${i}`;
      const id = String(item.id ?? "");
      if (!ASSET_ID_RE.test(id)) addError(errors, `${at}.id`, "Lowercase letters, digits and dashes");
      else if (ids.has(id)) addError(errors, `${at}.id`, `Duplicate id "${id}"`);
      ids.add(id);
      if (!item.description) addError(errors, `${at}.description`, "Say what is on screen; the strategist picks by this");
      if (item.upload !== undefined) {
        const up = getUpload(item.upload, kind as UploadKind);
        delete item.upload;
        if (!up) addError(errors, `${at}.path`, "The upload expired; upload it again");
        else if (ASSET_ID_RE.test(id)) {
          const rel = freeName(dir, sub, id, up.ext, taken);
          copies.push({ upload: up, rel });
          item.path = rel;
        }
      } else {
        const abs = create ? null : insideProduct(dir, item.path);
        if (!abs || !fs.existsSync(abs)) addError(errors, `${at}.path`, `File not found: ${String(item.path ?? "")}`);
      }
      return item;
    });
  }

  // Knowledge files.
  const knowledge: KnowledgeFile[] = [];
  const seen = new Set<string>();
  input.knowledge.forEach((k, i) => {
    const name = k.name.trim();
    if (!KNOWLEDGE_NAME_RE.test(name)) addError(errors, `knowledge.${i}.name`, "Use a name like 10-features.md (letters, digits, dashes)");
    else if (seen.has(name)) addError(errors, `knowledge.${i}.name`, `Duplicate file ${name}`);
    else if (Buffer.byteLength(k.content) > MAX_KNOWLEDGE_BYTES) addError(errors, `knowledge.${i}.content`, "Too long (256 KB max)");
    seen.add(name);
    knowledge.push({ name, content: k.content.replace(/\r\n/g, "\n") });
  });
  const knowledgeDelete = input.knowledge_delete.filter((n) => !seen.has(n));
  for (const n of knowledgeDelete) if (!KNOWLEDGE_NAME_RE.test(n)) addError(errors, "knowledge", `Bad file name ${n}`);
  const remaining = new Set([...(create ? [] : readKnowledgeFiles(dir).filter((k) => k.content.trim()).map((k) => k.name)), ...knowledge.filter((k) => k.content.trim()).map((k) => k.name)]);
  for (const k of knowledge) if (!k.content.trim()) remaining.delete(k.name);
  for (const n of knowledgeDelete) remaining.delete(n);
  if (!remaining.size) addError(errors, "knowledge", "Write at least one knowledge file: it is the only truth the agents use");

  // Schema last, so paths are filled in.
  const parsed = ProductConfig.safeParse(cfg);
  if (!parsed.success) for (const i of parsed.error.issues) addError(errors, i.path.map(String).join(".") || "config", issueMessage(i));
  if (parsed.success) {
    const pillarIds = new Set<string>();
    parsed.data.pillars.forEach((p, i) => {
      if (pillarIds.has(p.id)) addError(errors, `pillars.${i}.id`, `Duplicate pillar "${p.id}"`);
      pillarIds.add(p.id);
    });
  }
  if (Object.keys(errors).length || !parsed.success) throw new ProductWriteError(400, "Some fields need fixing", errors);
  return { config: parsed.data, copies, knowledge, knowledgeDelete, copyGeist, notes };
}

// ---------- write ----------

function writeFiles(dir: string, plan: Plan): void {
  for (const c of plan.copies) {
    const dest = path.join(dir, c.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(c.upload.file, dest);
  }
  const kdir = path.join(dir, "knowledge");
  fs.mkdirSync(kdir, { recursive: true });
  for (const k of plan.knowledge) {
    const file = path.join(kdir, k.name);
    const content = k.content.endsWith("\n") ? k.content : `${k.content}\n`;
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) continue;
    writeAtomic(file, content);
  }
  for (const n of plan.knowledgeDelete) fs.rmSync(path.join(kdir, n), { force: true });
}

/** Apply only what changed to the parsed YAML document, so comments on untouched parts survive. */
function patchDoc(doc: YAML.Document, at: (string | number)[], oldVal: unknown, newVal: unknown): void {
  if (isObj(oldVal) && isObj(newVal)) {
    for (const k of Object.keys(oldVal)) if (!(k in newVal)) doc.deleteIn([...at, k]);
    for (const [k, v] of Object.entries(newVal)) patchDoc(doc, [...at, k], oldVal[k], v);
    return;
  }
  if (Array.isArray(oldVal) && Array.isArray(newVal) && oldVal.length === newVal.length) {
    newVal.forEach((v, i) => patchDoc(doc, [...at, i], oldVal[i], v));
    return;
  }
  if (deepEqual(oldVal, newVal)) return;
  if (newVal === undefined) doc.deleteIn(at);
  else doc.setIn(at, doc.createNode(newVal));
}

function yamlFor(config: ProductConfig, existing?: string): string {
  if (existing) {
    try {
      const doc = YAML.parseDocument(existing);
      if (!doc.errors.length && isObj(doc.toJS())) {
        patchDoc(doc, [], doc.toJS(), JSON.parse(JSON.stringify(config)));
        return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
      }
    } catch {
      // fall through to a fresh file
    }
  }
  return `# ${config.name}. Written by the autocm dashboard; facts live in knowledge/*.md.\n${YAML.stringify(config, { lineWidth: 0 })}`;
}

function finish(plan: Plan): void {
  for (const c of plan.copies) dropUpload(c.upload.token);
}

/** Check the create form without writing anything. Returns the slug. Throws ProductWriteError with field errors. */
export function validateCreate(slugIn: unknown, body: unknown): string {
  const slug = typeof slugIn === "string" ? slugIn.trim() : "";
  if (!SLUG_RE.test(slug)) throw new ProductWriteError(400, "Some fields need fixing", { slug: "Lowercase letters, digits and dashes (max 40)" });
  const dir = productDir(slug);
  if (fs.existsSync(dir)) throw new ProductWriteError(409, `A product called "${slug}" already exists`, { slug: "Already taken" });
  planSave(slug, dir, body, true);
  return slug;
}

/** Create products/<slug>/ from the form. Throws ProductWriteError with field errors. */
export function createProduct(slugIn: unknown, body: unknown): SaveResult {
  const slug = validateCreate(slugIn, body);
  const dir = productDir(slug);
  const plan = planSave(slug, dir, body, true);

  fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
  const tmp = path.join(PRODUCTS_DIR, `.new-${slug}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmp);
  try {
    if (plan.copyGeist) {
      plan.config.brand.fonts.files = copyGeistFonts(tmp);
      if (!plan.config.brand.fonts.files.length) plan.notes.push("Geist was not found in node_modules; renders use the bundled fallback.");
    }
    writeFiles(tmp, plan);
    for (const sub of ["screens", "clips"]) fs.mkdirSync(path.join(tmp, "assets", sub), { recursive: true });
    fs.writeFileSync(path.join(tmp, "product.yaml"), yamlFor(plan.config));
    if (fs.existsSync(dir)) throw new ProductWriteError(409, `A product called "${slug}" already exists`, { slug: "Already taken" });
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  finish(plan);
  return { slug, created: true, notes: plan.notes };
}

/** Save the edit form over products/<slug>/. The slug comes from the URL, never from the body. */
export function updateProduct(slug: string, body: unknown): SaveResult {
  const dir = productDir(slug);
  const file = path.join(dir, "product.yaml");
  if (!fs.existsSync(file)) throw new ProductWriteError(404, `unknown product "${slug}"`);
  const plan = planSave(slug, dir, body, false);
  writeFiles(dir, plan);
  writeAtomic(file, yamlFor(plan.config, fs.readFileSync(file, "utf8")));
  finish(plan);
  return { slug, created: false, notes: plan.notes };
}
