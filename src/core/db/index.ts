import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DB_PATH } from "../paths.ts";
import type { PostRow, PostStatus } from "../types.ts";

let db: DatabaseSync | null = null;

export function getDb(file = DB_PATH): DatabaseSync {
  if (db) return db;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}

/** Tests: use a fresh in-memory DB. */
export function resetDb(file = ":memory:"): DatabaseSync {
  db?.close();
  db = null;
  return getDb(file);
}

export const nowIso = () => new Date().toISOString();

// ---------- posts ----------

type PostPatch = Partial<Omit<PostRow, "id" | "created_at">>;

export function insertPost(product: string, patch: PostPatch = {}): PostRow {
  const res = getDb().prepare("INSERT INTO posts (product) VALUES (?)").run(product);
  const id = Number(res.lastInsertRowid);
  if (Object.keys(patch).length) updatePost(id, patch);
  return getPost(id)!;
}

export function updatePost(id: number, patch: PostPatch): void {
  const entries = Object.entries({ ...patch, updated_at: nowIso() }).filter(([, v]) => v !== undefined);
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  getDb()
    .prepare(`UPDATE posts SET ${sets} WHERE id = ?`)
    .run(...entries.map(([, v]) => v as SQLInputValue), id);
}

export function getPost(id: number): PostRow | undefined {
  return getDb().prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow | undefined;
}

/** Most recent posts for a product, newest first. History includes dry_run posts on purpose. */
export function recentPosts(
  product: string,
  limit = 30,
  statuses: PostStatus[] = ["published", "dry_run", "approved", "publishing"],
): PostRow[] {
  const marks = statuses.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT * FROM posts WHERE product = ? AND status IN (${marks})
       ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`,
    )
    .all(product, ...statuses, limit) as unknown as PostRow[];
}

// ---------- flags ----------

export function getFlag(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM flags WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setFlag(key: string, value: string | null): void {
  if (value === null) getDb().prepare("DELETE FROM flags WHERE key = ?").run(key);
  else getDb().prepare("INSERT INTO flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---------- events / llm calls ----------

export function logEvent(type: string, data: { product?: string; post_id?: number; payload?: unknown } = {}): void {
  getDb()
    .prepare("INSERT INTO events (product, post_id, type, payload) VALUES (?, ?, ?, ?)")
    .run(data.product ?? null, data.post_id ?? null, type, data.payload === undefined ? null : JSON.stringify(data.payload));
}

export function logLlmCall(c: { post_id?: number; stage: string; model: string; ms: number; ok: boolean; error?: string; cost_usd?: number }): void {
  getDb()
    .prepare("INSERT INTO llm_calls (post_id, stage, model, ms, ok, error, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(c.post_id ?? null, c.stage, c.model, c.ms, c.ok ? 1 : 0, c.error ?? null, c.cost_usd ?? null);
}
