// Generation pipeline: strategist -> dedupe -> copywriter -> media -> critic, with bounded regeneration.
import fs from "node:fs";
import path from "node:path";
import { checkDuplicate } from "./agents/dedupe.ts";
import { writeDraft } from "./agents/copywriter.ts";
import { critique } from "./agents/critic.ts";
import { planBrief } from "./agents/strategist.ts";
import { capabilitiesFor, loadProduct } from "./core/config.ts";
import { getPost, insertPost, logEvent, recentPosts, updatePost } from "./core/db/index.ts";
import { log } from "./core/log.ts";
import { postOutDir } from "./core/paths.ts";
import type { Brief, Draft, Format, MediaResult, PostRow, QAVerdict } from "./core/types.ts";
import { produceMedia } from "./media/index.ts";
import { textHash } from "./safety/text.ts";

export interface GenerateOptions {
  /** Force a format instead of letting the strategist decide. */
  format?: Format;
  slotId?: number;
}

/** Regeneration rounds after the first attempt fails QA. */
const MAX_QA_ROUNDS = 3;
const MAX_DEDUPE_RETRIES = 2;

/**
 * Full generation for one post: strategist -> dedupe -> copywriter -> media -> critic (with regenerations).
 * Leaves the post `approved` (ready to publish) or `rejected`. Never publishes.
 */
export async function generatePost(productSlug: string, opts: GenerateOptions = {}): Promise<PostRow> {
  const product = loadProduct(productSlug);
  const caps = capabilitiesFor(product);
  const history = recentPosts(productSlug, 30);
  const row = insertPost(productSlug, { status: "generating", slot_id: opts.slotId ?? null });
  const postId = row.id;
  const outDir = postOutDir(productSlug, postId);
  fs.mkdirSync(outDir, { recursive: true });
  updatePost(postId, { out_dir: outDir });
  const save = (name: string, data: unknown) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2));
  const plog = log.child({ product: productSlug, post: postId });

  try {
    const avoid: string[] = [];

    const newBrief = async (): Promise<Brief> => {
      for (let i = 0; ; i++) {
        const b = await planBrief({ product, caps, history, format: opts.format, avoid, postId });
        const dup = await checkDuplicate(product, b, history, postId);
        if (!dup.duplicate || i >= MAX_DEDUPE_RETRIES) {
          if (dup.duplicate) plog.warn({ angle: b.angle }, "still duplicate after retries; QA will judge");
          return b;
        }
        plog.info({ angle: b.angle, of: dup.of_post_id, reason: dup.reason }, "duplicate idea, re-planning");
        logEvent("dedupe_rejected", { product: productSlug, post_id: postId, payload: { angle: b.angle, ...dup } });
        avoid.push(b.angle);
      }
    };

    let brief = await newBrief();
    let draft: Draft = await writeDraft({ product, brief, history, postId });
    let media: MediaResult = await produceMedia(brief, draft, product, caps, outDir);
    let verdict: QAVerdict = { pass: false, score: 0, issues: [], fix: "new_brief", visual_qa: "skipped" };
    const rounds: unknown[] = [];

    for (let round = 0; round <= MAX_QA_ROUNDS; round++) {
      updatePost(postId, { attempts: round + 1 });
      verdict = await critique({ product, brief, draft, media, history, postId });
      rounds.push({ round, brief, draft, media_kind: media.kind, verdict });
      plog.info({ round, score: verdict.score, pass: verdict.pass, fix: verdict.fix, issues: verdict.issues }, "qa");
      if (verdict.pass || round === MAX_QA_ROUNDS) break;

      if (verdict.fix === "new_brief") {
        avoid.push(brief.angle);
        brief = await newBrief();
        draft = await writeDraft({ product, brief, history, postId });
        media = await produceMedia(brief, draft, product, caps, outDir);
      } else if (verdict.fix === "rewrite_text") {
        draft = await writeDraft({ product, brief, history, feedback: verdict.issues, previous: draft, postId });
        // The media carries the draft's media_copy, so re-render it too.
        if (brief.media_kind !== "none") media = await produceMedia(brief, draft, product, caps, outDir);
      } else if (brief.media_kind === "ai_image" || brief.media_kind === "ai_video") {
        // Generative media differs on every run, so a plain re-render can fix it.
        media = await produceMedia(brief, draft, product, caps, outDir);
      } else {
        // Templates and Remotion are deterministic: the same copy renders the same frames, so fix the copy.
        draft = await writeDraft({ product, brief, history, feedback: verdict.issues, previous: draft, postId });
        media = await produceMedia(brief, draft, product, caps, outDir);
      }
    }

    save("brief.json", brief);
    save("draft.json", draft);
    save("media.json", media);
    save("qa.json", { final: verdict, rounds });

    updatePost(postId, {
      status: verdict.pass ? "approved" : "rejected",
      pillar: brief.pillar,
      angle: brief.angle,
      format: brief.format,
      media_kind: media.kind,
      text: draft.text,
      alt_text: draft.alt_text ?? null,
      media_json: JSON.stringify(media),
      brief_json: JSON.stringify(brief),
      qa_json: JSON.stringify(verdict),
      text_hash: textHash(draft.text),
      error: verdict.pass ? null : `QA rejected: ${verdict.issues.join("; ").slice(0, 500)}`,
    });
    logEvent(verdict.pass ? "post_approved" : "post_rejected", { product: productSlug, post_id: postId, payload: verdict });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    plog.error({ err: msg }, "generation failed");
    updatePost(postId, { status: "failed", error: msg.slice(0, 1000) });
    logEvent("generation_failed", { product: productSlug, post_id: postId, payload: { error: msg } });
  }
  return getPost(postId)!;
}
