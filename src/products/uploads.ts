// Staged uploads: files the dashboard sends (or the website prefill downloads) before the product is saved.
// Each one gets an opaque random token; saving a product only ever refers to tokens, never to client paths.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type UploadKind = "logo" | "screen" | "clip" | "font";

const MB = 1024 * 1024;

/** Allowed extensions and size caps per kind. */
export const UPLOAD_RULES: Record<UploadKind, { exts: string[]; maxBytes: number }> = {
  logo: { exts: [".svg", ".png", ".jpg", ".jpeg", ".webp"], maxBytes: 2 * MB },
  screen: { exts: [".png", ".jpg", ".jpeg", ".webp"], maxBytes: 10 * MB },
  clip: { exts: [".mp4", ".mov", ".webm"], maxBytes: 64 * MB },
  font: { exts: [".woff2"], maxBytes: 2 * MB },
};

/** Largest upload, base64-encoded inside a JSON body, plus some room for the other fields. */
export const MAX_UPLOAD_BODY = Math.ceil((UPLOAD_RULES.clip.maxBytes * 4) / 3) + 64 * 1024;

export interface StagedUpload {
  token: string;
  kind: UploadKind;
  /** Sanitized original file name. */
  name: string;
  ext: string;
  mime: string;
  bytes: number;
  file: string;
  created: number;
}

export class UploadError extends Error {}

const STAGING_DIR = path.join(os.tmpdir(), `autocm-staging-${process.getuid?.() ?? "u"}`);
const TTL_MS = 6 * 3600_000;
const staged = new Map<string, StagedUpload>();

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

/** Lowercase, ASCII, no separators: "My Logo (final).SVG" -> "my-logo-final.svg". */
export function safeFileName(name: string, fallback = "file"): string {
  const base = path.basename(String(name).replace(/\\/g, "/"));
  const ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const stem = base
    .slice(0, base.length - path.extname(base).length)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${stem || fallback}${ext}`;
}

/** The real type of the bytes, by magic number (SVG by its root element). Null when unknown. */
export function sniffExt(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return ".webp";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "wOF2") return ".woff2";
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return ".webm";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") return buf.toString("latin1", 8, 10) === "qt" ? ".mov" : ".mp4";
  const head = buf.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return ".svg";
  return null;
}

const SAME_KIND: Record<string, string> = { ".jpeg": ".jpg", ".mov": ".mp4" };
const norm = (ext: string) => SAME_KIND[ext] ?? ext;

function sweep(now = Date.now()): void {
  for (const [token, u] of staged) {
    if (now - u.created < TTL_MS) continue;
    fs.rmSync(path.dirname(u.file), { recursive: true, force: true });
    staged.delete(token);
  }
}

/** Validate and stage bytes. The extension is taken from the content, not from the name. */
export function stageUpload(kind: UploadKind, name: string, data: Buffer): StagedUpload {
  const rules = UPLOAD_RULES[kind];
  if (!rules) throw new UploadError(`unknown upload kind "${kind}"`);
  if (!data.length) throw new UploadError("the file is empty");
  if (data.length > rules.maxBytes) throw new UploadError(`the file is ${(data.length / MB).toFixed(1)} MB; the limit for a ${kind} is ${rules.maxBytes / MB} MB`);
  const sniffed = sniffExt(data);
  if (!sniffed || !rules.exts.map(norm).includes(norm(sniffed))) {
    throw new UploadError(`a ${kind} must be ${rules.exts.filter((e) => e !== ".jpeg").join(", ")}; this file is ${sniffed ?? "of an unknown type"}`);
  }
  // Keep .mov/.mp4 as the client named it when both are the same container family.
  const claimed = path.extname(String(name)).toLowerCase();
  const ext = claimed && norm(claimed) === norm(sniffed) && rules.exts.includes(claimed) ? (claimed === ".jpeg" ? ".jpg" : claimed) : sniffed;
  sweep();
  const token = crypto.randomBytes(16).toString("hex");
  const dir = path.join(STAGING_DIR, token);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = safeFileName(name, kind).replace(/\.[a-z0-9]+$/, "") + ext;
  const file = path.join(dir, `upload${ext}`);
  fs.writeFileSync(file, data, { mode: 0o600 });
  const u: StagedUpload = { token, kind, name: safe, ext, mime: MIME[ext] ?? "application/octet-stream", bytes: data.length, file, created: Date.now() };
  staged.set(token, u);
  return u;
}

/** A staged upload by token, or null (unknown, expired or malformed token). */
export function getUpload(token: unknown, kind?: UploadKind): StagedUpload | null {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  const u = staged.get(token);
  if (!u || !fs.existsSync(u.file)) return null;
  if (kind && u.kind !== kind) return null;
  return u;
}

/** Forget a staged upload and delete its file. */
export function dropUpload(token: string): void {
  const u = staged.get(token);
  if (!u) return;
  fs.rmSync(path.dirname(u.file), { recursive: true, force: true });
  staged.delete(token);
}

/** Decode a base64 payload (plain or data: URL) with a size cap checked before decoding. */
export function decodeBase64(data: unknown, maxBytes: number): Buffer {
  if (typeof data !== "string" || !data) throw new UploadError("file data missing");
  const b64 = data.replace(/^data:[^;,]*;base64,/, "");
  if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) throw new UploadError("file data must be base64");
  if (Math.floor((b64.length * 3) / 4) > maxBytes + 3) throw new UploadError(`the file is larger than ${maxBytes / MB} MB`);
  return Buffer.from(b64, "base64");
}
