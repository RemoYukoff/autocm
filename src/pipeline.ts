// Generation pipeline: marketer -> dedupe -> copywriter -> media (designer for images). No LLM review; only X hard limits are checked.
import fs from "node:fs";
import path from "node:path";
import { checkDuplicate } from "./agents/dedupe.ts";
import { writeDraft, type Written } from "./agents/copywriter.ts";
import { mediaIssues, textIssues } from "./agents/checks.ts";
import { planBrief } from "./agents/marketer.ts";
import { capabilitiesFor, loadProduct } from "./core/config.ts";
import { getPost, insertPost, logEvent, recentPosts, updatePost } from "./core/db/index.ts";
import { log } from "./core/log.ts";
import { postOutDir } from "./core/paths.ts";
import type { Brief, MediaResult, PostRow } from "./core/types.ts";
import { produceMedia } from "./media/index.ts";
import { textHash } from "./safety/text.ts";

export interface GenerateOptions {
  slotId?: number;
}

/** Copy rewrites when the tweet does not fit in 280 weighted chars. */
const MAX_REWRITES = 2;
const MAX_DEDUPE_RETRIES = 2;

/**
 * Full generation for one post: marketer -> dedupe -> copywriter -> media.
 * Leaves the post `approved` (ready to publish), or `failed` if X would refuse it. Never publishes.
 */
export async function generatePost(productSlug: string, opts: GenerateOptions = {}): Promise<PostRow> {
  const product = loadProduct(productSlug);
  const caps = capabilitiesFor(product);
  const history = recentPosts(productSlug, 30);
  const row = insertPost(productSlug, { status: "generating", slot_id: opts.slotId ?? null });
  const postId = row.id;
  const outDir = postOutDir(productSlug, postId);
  fs.mkdirSync(outDir, { recursive: true });
  const save = (name: string, data: unknown) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2));
  const plog = log.child({ product: productSlug, post: postId });

  try {
    const avoid: string[] = [];

    const newBrief = async (): Promise<Brief> => {
      for (let i = 0; ; i++) {
        const b = await planBrief({ product, caps, history, avoid, postId });
        const dup = await checkDuplicate(product, b, history, postId);
        if (!dup.duplicate || i >= MAX_DEDUPE_RETRIES) {
          if (dup.duplicate) plog.warn({ angle: b.angle }, "still duplicate after retries; keeping the last idea");
          return b;
        }
        plog.info({ angle: b.angle, of: dup.of_post_id, reason: dup.reason }, "duplicate idea, re-planning");
        logEvent("dedupe_rejected", { product: productSlug, post_id: postId, payload: { angle: b.angle, ...dup } });
        avoid.push(b.angle);
      }
    };

    const brief = await newBrief();
    save("brief.json", brief);
    let written: Written = await writeDraft({ product, brief, history, postId });
    // Only rule enforced on the text: it must fit in a tweet.
    for (let i = 0; i < MAX_REWRITES && textIssues(written.draft).length; i++) {
      written = await writeDraft({ product, brief, history, feedback: textIssues(written.draft), previous: written.draft, postId });
    }
    const draft = written.draft;
    save("copy.json", written);
    const media: MediaResult = await produceMedia(brief, draft, product, caps, outDir, postId);
    const issues = [...textIssues(draft), ...mediaIssues(brief, media)];
    updatePost(postId, { attempts: 1 });
    save("media.json", media);

    updatePost(postId, {
      status: issues.length ? "failed" : "approved",
      goal: brief.goal,
      play: brief.play,
      pillar: brief.pillar,
      angle: brief.angle,
      format: brief.format,
      media_kind: media.kind,
      text: draft.text,
      alt_text: media.alt_text ?? null,
      media_json: JSON.stringify(media),
      brief_json: JSON.stringify(brief),
      text_hash: textHash(draft.text),
      error: issues.length ? `Not publishable on X: ${issues.join("; ").slice(0, 500)}` : null,
    });
    logEvent(issues.length ? "post_unpublishable" : "post_approved", { product: productSlug, post_id: postId, payload: { issues } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    plog.error({ err: msg }, "generation failed");
    updatePost(postId, { status: "failed", error: msg.slice(0, 1000) });
    logEvent("generation_failed", { product: productSlug, post_id: postId, payload: { error: msg } });
  }
  return getPost(postId)!;
}
