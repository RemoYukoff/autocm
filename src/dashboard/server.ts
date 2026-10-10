// Local dashboard: see posts before the scheduler publishes them, and veto them. Binds 127.0.0.1 only, no auth.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { log } from "../core/log.ts";
import { OUT_DIR, ROOT } from "../core/paths.ts";
import { Format } from "../core/types.ts";
import {
  ActionError,
  discardPost,
  generateNow,
  listJobs,
  pausePublishing,
  publishNow,
  regenerateSlot,
  resumePublishing,
  skipSlot,
} from "./actions.ts";
import { headerState, historyPosts, postView, readyPosts, upcomingSlots } from "./queries.ts";

export const DEFAULT_PORT = 4321;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const FONT_FILE = path.join(ROOT, "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Resolve `/media/<rel>` to a file inside OUT_DIR, or null. Decodes each segment, rejects anything that
 * resolves (lexically or through symlinks) outside OUT_DIR.
 */
export function resolveMediaPath(urlPath: string, root = OUT_DIR): string | null {
  let segments: string[];
  try {
    segments = urlPath.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (!segments.length || segments.some((s) => s.includes("\0") || s.includes("/") || s.includes("\\"))) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, ...segments);
  if (!abs.startsWith(base + path.sep)) return null;
  let real: string;
  let realBase: string;
  try {
    real = fs.realpathSync(abs);
    realBase = fs.realpathSync(base);
  } catch {
    return null;
  }
  if (!real.startsWith(realBase + path.sep)) return null;
  if (!fs.statSync(real).isFile()) return null;
  return real;
}

/** Stream a file with HTTP Range support (video seeking needs it). */
function sendFile(c: Context, file: string, cache = "no-cache"): Response {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" };
  const range = c.req.header("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    start = Math.max(0, start);
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}

function fail(c: Context, e: unknown) {
  if (e instanceof ActionError) return c.json({ error: e.message, guard: e.guard ?? null }, e.status);
  log.error({ err: (e as Error).message }, "dashboard action failed");
  return c.json({ error: (e as Error).message }, 500);
}

function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new ActionError(400, `bad id "${c.req.param("id")}"`);
  return id;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = (await c.req.json()) as unknown;
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseFormat(v: unknown): Format | undefined {
  if (v === undefined || v === null || v === "" || v === "auto") return undefined;
  const r = Format.safeParse(v);
  if (!r.success) throw new ActionError(400, `format must be auto, text, image or video`);
  return r.data;
}

export function createApp(): Hono {
  const app = new Hono();

  // Local only: refuse other Host headers (DNS rebinding) and cross-site form posts (CSRF).
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (host && !LOCAL_HOSTS.has(host)) return c.text("forbidden host", 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "JSON body required" }, 415);
      const origin = c.req.header("origin");
      if (origin) {
        let ok = false;
        try {
          ok = LOCAL_HOSTS.has(new URL(origin).hostname) || LOCAL_HOSTS.has(`[${new URL(origin).hostname}]`);
        } catch {
          ok = false;
        }
        if (!ok) return c.json({ error: "cross-origin request refused" }, 403);
      }
    }
    await next();
  });

  // ---------- page ----------
  const page = (name: string, cache = "no-cache") => (c: Context) => {
    const file = path.join(PUBLIC_DIR, name);
    return fs.existsSync(file) ? sendFile(c, file, cache) : c.notFound();
  };
  app.get("/", page("index.html"));
  app.get("/app.js", page("app.js"));
  app.get("/app.css", page("app.css"));
  app.get("/fonts/geist.woff2", (c) => (fs.existsSync(FONT_FILE) ? sendFile(c, FONT_FILE, "max-age=86400") : c.notFound()));

  // ---------- media ----------
  app.get("/media/*", (c) => {
    const raw = new URL(c.req.url).pathname.replace(/^\/media\//, "");
    const file = resolveMediaPath(raw);
    if (!file) return c.text("not found", 404);
    return sendFile(c, file, "max-age=60");
  });

  // ---------- read API ----------
  app.get("/api/state", (c) => c.json({ ...headerState(), upcoming: upcomingSlots(), ready: readyPosts(), jobs: listJobs() }));
  app.get("/api/history", (c) => {
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    return c.json({ offset, limit, ...historyPosts(offset, limit) });
  });

  // ---------- actions ----------
  app.post("/api/posts/:id/discard", (c) => {
    try {
      const r = discardPost(idParam(c));
      return c.json({ post: postView(r.post), slot: r.slot });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/posts/:id/publish", async (c) => {
    try {
      const r = await publishNow(idParam(c));
      return c.json({ post: postView(r.post), result: r.result });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/slots/:id/regenerate", async (c) => {
    try {
      const b = await body(c);
      return c.json({ job: regenerateSlot(idParam(c), parseFormat(b.format)) }, 202);
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/slots/:id/skip", (c) => {
    try {
      return c.json({ slot: skipSlot(idParam(c)) });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/generate", async (c) => {
    try {
      const b = await body(c);
      if (typeof b.product !== "string" || !b.product) throw new ActionError(400, "product required");
      return c.json({ job: generateNow(b.product, parseFormat(b.format)) }, 202);
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/pause", async (c) => {
    const b = await body(c);
    return c.json({ paused: pausePublishing(typeof b.reason === "string" ? b.reason : undefined) });
  });
  app.post("/api/resume", (c) => c.json({ paused: resumePublishing() }));

  return app;
}

/** Start the dashboard on 127.0.0.1:<port>. A bind failure is logged, never thrown (the daemon keeps running). */
export function startDashboard(port = DEFAULT_PORT, onError?: (e: Error) => void): ServerType {
  const app = createApp();
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    log.info({ url: `http://127.0.0.1:${info.port}` }, "dashboard listening");
  });
  server.on("error", (e: Error) => {
    log.error({ port, err: e.message }, "dashboard could not start");
    onError?.(e);
  });
  return server;
}
