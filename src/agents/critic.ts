// Critic: deterministic checks first, then a model review of text and visuals. Nothing ships without passing.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Brief, Draft, MediaResult, PostRow, Product, QAVerdict } from "../core/types.ts";
import { QAFix } from "../core/types.ts";
import { callJson } from "../llm.ts";
import { weightedLength } from "./copywriter.ts";
import { historyContext, productContext } from "./context.ts";

export const PASS_SCORE = 7;

const X_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  videoBytes: 512 * 1024 * 1024,
  videoMaxS: 140,
  videoMinS: 0.5,
};

/** Hard rules. Any issue here means the post cannot pass. */
export function deterministicIssues(product: Product, brief: Brief, draft: Draft, media: MediaResult): { issues: string[]; fix: QAFix } {
  const c = product.config;
  const text = draft.text;
  const textIssues: string[] = [];
  const mediaIssues: string[] = [];

  const len = weightedLength(text);
  if (len > 280) textIssues.push(`Tweet is ${len} weighted chars; max 280. Shorten it.`);
  if (text.trim().length < 20) textIssues.push("Tweet text is too short to stand on its own.");
  const lower = text.toLowerCase();
  for (const b of c.voice.banned_phrases) if (lower.includes(b.toLowerCase())) textIssues.push(`Uses banned phrase "${b}".`);
  const hashtags = text.match(/(^|\s)#\w+/g) ?? [];
  if (hashtags.length > c.hashtags.max_per_post) textIssues.push(`Has ${hashtags.length} hashtags; max ${c.hashtags.max_per_post}.`);
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  if (!brief.include_link && urls.length) textIssues.push("Contains a link but the brief says no link.");
  if (urls.length > 1) textIssues.push("More than one link.");
  if (text.includes("{{")) textIssues.push("Unreplaced template placeholder in text.");
  if (brief.media_kind !== "none" && !draft.alt_text) textIssues.push("Missing alt text for the media.");

  if (brief.media_kind !== "none") {
    if (!media.files.length) mediaIssues.push("No media file was produced.");
    for (const f of media.files) {
      if (!fs.existsSync(f.path)) mediaIssues.push(`Media file missing: ${path.basename(f.path)}`);
      if (f.mime.startsWith("image/") && f.bytes > X_LIMITS.imageBytes) mediaIssues.push(`Image is ${(f.bytes / 1e6).toFixed(1)} MB; X max is 5 MB.`);
      if (f.mime.startsWith("video/")) {
        if (f.bytes > X_LIMITS.videoBytes) mediaIssues.push("Video exceeds 512 MB.");
        if (f.duration_s !== undefined && (f.duration_s > X_LIMITS.videoMaxS || f.duration_s < X_LIMITS.videoMinS))
          mediaIssues.push(`Video duration ${f.duration_s}s outside 0.5-140s.`);
      }
    }
    for (const n of media.notes) if (/^qa:/i.test(n)) mediaIssues.push(n.replace(/^qa:\s*/i, ""));
  }

  const issues = [...textIssues, ...mediaIssues];
  const fix: QAFix = mediaIssues.length ? "rerender" : textIssues.length ? "rewrite_text" : "none";
  return { issues, fix };
}

const ReviewSchema = z.object({
  score: z.number().min(0).max(10).describe("Overall quality as a post for this brand: 10 = would stop a QA lead's scroll"),
  issues: z.array(z.string()).describe("Concrete problems, each actionable. Empty if none."),
  fix: QAFix.describe("none if publishable; rewrite_text if the words are the problem; rerender if only the visual is broken; new_brief if the idea itself is weak or repetitive"),
  visual_checked: z.boolean().describe("true only if you actually opened and inspected the image/frames"),
});

export interface CriticInput {
  product: Product;
  brief: Brief;
  draft: Draft;
  media: MediaResult;
  history: PostRow[];
  postId?: number;
}

export async function critique(input: CriticInput): Promise<QAVerdict> {
  const { product, brief, draft, media } = input;
  const hard = deterministicIssues(product, brief, draft, media);
  if (hard.issues.length) return { pass: false, score: 0, issues: hard.issues, fix: hard.fix, visual_qa: "skipped" };

  const frames = media.preview_frames.filter((f) => fs.existsSync(f));
  const visual = frames.length > 0;
  const dirs = [...new Set(frames.map((f) => path.dirname(f)))];

  const review = await callJson(
    ReviewSchema,
    `You are the last quality gate before an automated post goes live on ${product.config.name}'s X account. Nobody else reviews it. Be strict but fair.

${productContext(product)}

# Recent posts
${historyContext(input.history, 15)}

# Candidate post
Brief: ${JSON.stringify(brief)}
Tweet text:
"""
${draft.text}
"""
${draft.alt_text ? `Alt text: ${draft.alt_text}` : ""}
Media: ${media.kind}${media.fallback_from ? ` (fallback from ${media.fallback_from})` : ""}
${visual ? `\nOpen and inspect each of these ${brief.format === "video" ? "video frames" : "images"} with the Read tool before judging:\n${frames.map((f) => `- ${f}`).join("\n")}\nCheck: text fully visible (no clipping/overflow), legible contrast, no typos, on-brand, looks professional, matches the tweet.` : ""}

# Judge
- Hook: would the target audience stop scrolling?
- Voice rules followed? Claims supported by the knowledge base (no invented numbers/customers)?
- Not repetitive versus recent posts? Reusing a line verbatim from the example posts or knowledge base is a fail (fix rewrite_text).
- Clear and specific, not generic marketing filler?
${visual ? "- Visual quality as described above." : ""}
Score ${PASS_SCORE}+ only if you would publish it as is.`,
    {
      stage: "critic",
      model: "sonnet",
      tools: visual ? ["Read"] : [],
      cwd: dirs[0],
      addDirs: dirs.slice(1),
      postId: input.postId,
    },
  );

  const pass = review.score >= PASS_SCORE && review.fix === "none";
  return {
    pass,
    score: review.score,
    issues: review.issues,
    fix: pass ? "none" : review.fix === "none" ? "rewrite_text" : review.fix,
    visual_qa: visual && review.visual_checked ? "done" : "skipped",
  };
}
