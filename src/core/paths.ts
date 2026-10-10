import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PRODUCTS_DIR = process.env.AUTOCM_PRODUCTS_DIR ?? path.join(ROOT, "products");
export const TEMPLATES_DIR = path.join(ROOT, "templates");
export const REMOTION_DIR = path.join(ROOT, "remotion");
export const DATA_DIR = process.env.AUTOCM_DATA_DIR ?? path.join(ROOT, "data");
export const OUT_DIR = process.env.AUTOCM_OUT_DIR ?? path.join(ROOT, "out");
export const DB_PATH = process.env.AUTOCM_DB ?? path.join(DATA_DIR, "autocm.db");
export const PAUSE_FILE = path.join(DATA_DIR, "PAUSE");
/** Browser profiles with the logged-in X session, one per product. Holds auth cookies: never log or commit. */
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const FIXTURES_DIR = path.join(ROOT, "fixtures");

/** out/<product>/<YYYY-MM-DD>/<postId>/ */
export function postOutDir(product: string, postId: number, date = new Date()): string {
  return path.join(OUT_DIR, product, date.toISOString().slice(0, 10), String(postId).padStart(5, "0"));
}

/** data/sessions/<product>/ — persistent browser profile for the product's X account. */
export function sessionDir(product: string): string {
  return path.join(SESSIONS_DIR, product);
}
