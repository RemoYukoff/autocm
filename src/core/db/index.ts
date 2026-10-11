import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DB_PATH } from "../paths.ts";
import type { PostRow, PostStatus, XAccount } from "../types.ts";

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

/** Most recent posts for a product, newest first. */
export function recentPosts(
  product: string,
  limit = 30,
  statuses: PostStatus[] = ["published", "approved", "publishing"],
): PostRow[] {
  const marks = statuses.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT * FROM posts WHERE product = ? AND status IN (${marks})
       ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`,
    )
    .all(product, ...statuses, limit) as unknown as PostRow[];
}

/** What a post discarded from the dashboard was about (kept in its post_discarded event). */
export type Discarded = Pick<PostRow, "goal" | "play" | "pillar" | "format" | "angle" | "text">;

/** Posts the owner discarded from the dashboard, newest first. */
export function discardedPosts(product: string, limit = 10): (Discarded & { ts: string })[] {
  const rows = getDb()
    .prepare("SELECT ts, payload FROM events WHERE product = ? AND type = 'post_discarded' ORDER BY id DESC LIMIT ?")
    .all(product, limit) as { ts: string; payload: string }[];
  return rows.map((r) => ({ ts: r.ts, ...(JSON.parse(r.payload) as Discarded) }));
}

/** Store engagement read back from X. */
export function savePostMetrics(id: number, m: Pick<PostRow, "views" | "likes" | "reposts" | "replies" | "quotes" | "bookmarks">): void {
  getDb()
    .prepare("UPDATE posts SET views = ?, likes = ?, reposts = ?, replies = ?, quotes = ?, bookmarks = ?, metrics_at = ? WHERE id = ?")
    .run(m.views, m.likes, m.reposts, m.replies, m.quotes, m.bookmarks, nowIso(), id);
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

// ---------- X accounts ----------

export function getXAccount(product: string): XAccount | null {
  return (getDb().prepare("SELECT * FROM x_accounts WHERE product = ?").get(product) as unknown as XAccount | undefined) ?? null;
}

export function listXAccounts(): XAccount[] {
  return getDb().prepare("SELECT * FROM x_accounts ORDER BY product").all() as unknown as XAccount[];
}

/** Insert or replace the product's account row. */
export function saveXAccount(a: Omit<XAccount, "last_ok_at" | "error"> & Partial<Pick<XAccount, "last_ok_at" | "error">>): void {
  getDb()
    .prepare(
      `INSERT INTO x_accounts (product, handle, name, avatar_path, connected_at, last_ok_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(product) DO UPDATE SET handle = excluded.handle, name = excluded.name, avatar_path = excluded.avatar_path,
         connected_at = excluded.connected_at, last_ok_at = excluded.last_ok_at, error = excluded.error`,
    )
    .run(a.product, a.handle, a.name, a.avatar_path, a.connected_at, a.last_ok_at ?? null, a.error ?? null);
}

/** Record the outcome of a browser operation on the account: ok sets last_ok_at and clears error. */
export function markXAccount(product: string, result: { ok: true } | { ok: false; error: string }): void {
  if (result.ok) getDb().prepare("UPDATE x_accounts SET last_ok_at = ?, error = NULL WHERE product = ?").run(nowIso(), product);
  else getDb().prepare("UPDATE x_accounts SET error = ? WHERE product = ?").run(result.error, product);
}

export function deleteXAccount(product: string): void {
  getDb().prepare("DELETE FROM x_accounts WHERE product = ?").run(product);
}

/** Forget a deleted product: its slots, posts, events and X account row. */
export function deleteProductData(product: string): void {
  const db = getDb();
  for (const table of ["slots", "posts", "events", "x_accounts"]) db.prepare(`DELETE FROM ${table} WHERE product = ?`).run(product);
  db.prepare("DELETE FROM flags WHERE key IN (?, ?)").run(`paused:${product}`, `consecutive_failures:${product}`);
}
