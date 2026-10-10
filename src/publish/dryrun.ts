// Dry-run "publishing": write a human-readable preview of what would have gone out.
import fs from "node:fs";
import path from "node:path";
import { postOutDir } from "../core/paths.ts";
import type { MediaResult, PostRow, Product } from "../core/types.ts";
import { weightedLength } from "../safety/guards.ts";

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Media files listed in post.media_json (empty for text posts or unparsable JSON). */
export function postMediaFiles(post: PostRow): MediaResult["files"] {
  return parseJson<Partial<MediaResult>>(post.media_json)?.files ?? [];
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/** Directory where this post's artifacts (and the dry-run preview) live. */
export function previewDir(post: PostRow): string {
  return post.out_dir ?? postOutDir(post.product, post.id);
}

/** Write `<out_dir>/post.md` and return its path. */
export function writeDryRunPreview(post: PostRow, product: Product, at = new Date()): string {
  const dir = previewDir(post);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "post.md");
  const text = post.text ?? "";
  const len = weightedLength(text);
  const files = postMediaFiles(post);
  const brief = parseJson<Record<string, unknown>>(post.brief_json);

  const lines: string[] = [
    `# ${product.config.name} — post #${post.id} (dry run)`,
    "",
    `- product: ${post.product}${product.config.handle ? ` (@${product.config.handle.replace(/^@/, "")})` : ""}`,
    `- previewed_at: ${at.toISOString()}`,
    `- format: ${post.format ?? "-"} / ${post.media_kind ?? "-"}`,
    `- pillar: ${post.pillar ?? "-"}`,
    `- weighted length: ${len.length}/280`,
    post.slot_id !== null ? `- slot: ${post.slot_id}` : "",
    "",
    "## Text",
    "",
    quote(text),
    "",
  ];

  if (files.length) {
    lines.push("## Media", "");
    for (const f of files) {
      const rel = path.relative(dir, f.path) || path.basename(f.path);
      const meta = `${f.mime}, ${f.width}x${f.height}, ${(f.bytes / 1024).toFixed(0)} KB${f.duration_s ? `, ${f.duration_s.toFixed(1)} s` : ""}`;
      lines.push(f.mime.startsWith("image/") ? `![media](${rel})` : `- [${path.basename(f.path)}](${rel})`, `  ${meta}`, "");
    }
    lines.push("## Alt text", "", post.alt_text ? quote(post.alt_text) : "_(none)_", "");
  }

  if (brief) {
    lines.push("## Brief", "");
    for (const k of ["angle", "hook_idea", "include_link", "rationale"]) {
      if (brief[k] !== undefined) lines.push(`- ${k}: ${String(brief[k])}`);
    }
    lines.push("");
  } else if (post.angle) {
    lines.push("## Brief", "", `- angle: ${post.angle}`, "");
  }

  fs.writeFileSync(file, lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"));
  return file;
}
