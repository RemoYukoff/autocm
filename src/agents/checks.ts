// Hard checks for what X itself would refuse. No LLM review: if these pass, the post is publishable.
import fs from "node:fs";
import path from "node:path";
import type { Brief, Draft, MediaResult } from "../core/types.ts";
import { weightedLength } from "./copywriter.ts";

const X_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  videoBytes: 512 * 1024 * 1024,
  videoMaxS: 140,
  videoMinS: 0.5,
};

/** Problems with the tweet text that X would reject. */
export function textIssues(draft: Draft): string[] {
  const issues: string[] = [];
  const len = weightedLength(draft.text);
  if (len > 280) issues.push(`Tweet is ${len} weighted chars; max 280. Shorten it.`);
  if (!draft.text.trim()) issues.push("Tweet text is empty.");
  return issues;
}

/** Problems with the media files that X would reject. */
export function mediaIssues(brief: Brief, media: MediaResult): string[] {
  if (brief.media_kind === "none") return [];
  const issues: string[] = [];
  if (!media.files.length) issues.push("No media file was produced.");
  for (const f of media.files) {
    if (!fs.existsSync(f.path)) issues.push(`Media file missing: ${path.basename(f.path)}`);
    if (f.mime.startsWith("image/") && f.bytes > X_LIMITS.imageBytes) issues.push(`Image is ${(f.bytes / 1e6).toFixed(1)} MB; X max is 5 MB.`);
    if (f.mime.startsWith("video/")) {
      if (f.bytes > X_LIMITS.videoBytes) issues.push("Video exceeds 512 MB.");
      if (f.duration_s !== undefined && (f.duration_s > X_LIMITS.videoMaxS || f.duration_s < X_LIMITS.videoMinS))
        issues.push(`Video duration ${f.duration_s}s outside 0.5-140s.`);
    }
  }
  // ffprobe findings from the media stage (codec, pixel format, size) are things X rejects too.
  for (const n of media.notes) if (/^qa:/i.test(n)) issues.push(n.replace(/^qa:\s*/i, ""));
  return issues;
}
