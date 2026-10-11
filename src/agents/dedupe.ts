// Dedupe: is this brief the same idea as something already posted? Cheap similarity first, then haiku.
import { z } from "zod";
import type { Brief, PostRow, Product } from "../core/types.ts";
import { callJson } from "../llm.ts";
import { trigramSimilarity } from "../safety/text.ts";

export interface DedupeVerdict {
  duplicate: boolean;
  of_post_id?: number;
  reason?: string;
}

/** Similarity above this is treated as a duplicate without asking the model. */
const SURE_DUPLICATE = 0.8;
/** Candidates above this get a model check. */
const CANDIDATE = 0.25;

export async function checkDuplicate(product: Product, brief: Brief, history: PostRow[], postId?: number): Promise<DedupeVerdict> {
  const idea = `${brief.angle} ${brief.hook_idea}`;
  const scored = history
    .filter((p) => p.angle || p.text)
    .map((p) => ({ p, score: Math.max(trigramSimilarity(idea, p.angle ?? ""), trigramSimilarity(idea, p.text ?? "")) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (top && top.score >= SURE_DUPLICATE) return { duplicate: true, of_post_id: top.p.id, reason: `similarity ${top.score.toFixed(2)}` };

  // Recent posts are always checked by the model, plus anything lexically close.
  const candidates = [...new Map([...history.slice(0, 8), ...scored.filter((s) => s.score >= CANDIDATE).slice(0, 5).map((s) => s.p)].map((p) => [p.id, p])).values()];
  if (!candidates.length) return { duplicate: false };

  const verdict = await callJson(
    z.object({
      duplicate: z.boolean().describe("true only if a reader of that past post would feel they are reading it again"),
      of_post_id: z.number().int().optional(),
      reason: z.string(),
    }),
    `You check an X account (${product.config.name}) for repetitive content.
New post idea: angle="${brief.angle}", hook="${brief.hook_idea}", pillar=${brief.pillar}.

Past posts:
${candidates.map((p) => `#${p.id} angle="${p.angle}" text="${(p.text ?? "").replace(/\s+/g, " ").slice(0, 200)}"`).join("\n")}

Is the new idea a duplicate? A brand repeats its core message on purpose: the same thesis told through a different
scenario, example, play or format is NOT a duplicate. It is a duplicate only when a reader who saw the past post would
feel they are reading it again: the same example or scenario making the same point, even reworded.`,
    { stage: "dedupe", model: "haiku", postId },
  );
  return verdict;
}
