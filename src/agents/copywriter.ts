// Copywriter: turns a Brief into the tweet. Writes several versions with different hooks and picks the strongest.
// The words inside an image or a video are the designer's and editor's, from the marketer's concept.
import twitterText from "twitter-text";
import { z } from "zod";
import type { Brief, Draft, PostRow, Product } from "../core/types.ts";
import { callJson } from "../llm.ts";
import { historyContext, productContext } from "./context.ts";
import { COPY_RULES, GOAL_GUIDE, HOOKS, PLAY_GUIDE } from "./playbook.ts";

export const LINK_PLACEHOLDER = "{{LINK}}";

export interface CopywriterInput {
  product: Product;
  brief: Brief;
  history: PostRow[];
  /** Problems with the previous draft to fix (e.g. too long). */
  feedback?: string[];
  previous?: Draft;
  postId?: number;
}

/** The chosen tweet plus every version written, kept with the post's files. */
export interface Written {
  draft: Draft;
  variants: { hook: string; text: string }[];
  chosen: number;
  why: string;
}

const Variant = z.object({
  hook: z.string().describe("The hook technique this version uses"),
  text: z.string().describe("The full tweet"),
});

export async function writeDraft(input: CopywriterInput): Promise<Written> {
  const { product, brief, feedback = [], previous } = input;
  const c = product.config;
  const schema = z.object({
    variants: z.array(Variant).min(3).max(4).describe("3-4 genuinely different versions, each with a different hook technique"),
    chosen: z.number().int().describe("0-based index of the version most likely to stop the scroll and get replies or bookmarks"),
    why: z.string().describe("One sentence: why that version wins"),
  });

  const prompt = `You are the copywriter of ${c.name}'s X (Twitter) account. The head of marketing decided the next post;
you write it.

${productContext(product)}

# Recent posts (do not repeat their hooks or phrasing)
${historyContext(input.history, 15)}

# Brief
Goal: ${brief.goal}: ${GOAL_GUIDE[brief.goal]}
Play: ${brief.play}: ${PLAY_GUIDE[brief.play]}
Pillar: ${brief.pillar}
Reader insight: ${brief.insight}
Angle: ${brief.angle}
Hook idea: ${brief.hook_idea}
${brief.visual ? `The post carries ${brief.media_kind === "design" ? "an image the designer makes" : "a video the motion designer makes"} from this concept: ${brief.visual.concept}\nWords on it: ${brief.visual.words}\nThe tweet must work with it, not describe or repeat it.` : ""}

# How to write
${COPY_RULES.map((r) => `- ${r}`).join("\n")}

Hook techniques to choose from (use a different one per version):
${HOOKS.map((h) => `- ${h}`).join("\n")}

# Hard rules
- Max 280 characters (URLs count as 23). Aim for 100-240. Language: ${c.language}. A single post, no thread.
- Follow the voice rules. Never use banned phrases. At most ${c.hashtags.max_per_post} hashtag(s); usually zero.
- Claims about the product come only from the knowledge base: no invented numbers, customers, quotes or features.
  Scenes from the reader's job may be illustrative (a made-up ticket or bug) as long as they claim nothing about the product.
- Example posts show the voice; never copy their lines. Write fresh hooks.
- ${brief.include_link ? `Include the placeholder ${LINK_PLACEHOLDER} exactly once where the link goes (it becomes ${c.links.cta_url}).` : "Do not include any URL or link."}
${previous ? `\n# Previous version (rejected)\n${JSON.stringify(previous, null, 2)}` : ""}
${feedback.length ? `\n# Fix these issues in every version\n${feedback.map((f) => `- ${f}`).join("\n")}` : ""}`;

  const out = await callJson(schema, prompt, { stage: "copywriter", model: "opus", postId: input.postId });
  const chosen = Math.min(Math.max(0, out.chosen), out.variants.length - 1);
  const draft: Draft = { text: out.variants[chosen]!.text };
  return { draft: finalizeDraft(draft, brief, product), variants: out.variants, chosen, why: out.why };
}

/** Replace the link placeholder with the tracked URL. */
export function finalizeDraft(draft: Draft, brief: Brief, product: Product): Draft {
  const { cta_url, utm } = product.config.links;
  const link = utm ? `${cta_url}${cta_url.includes("?") ? "&" : "?"}${utm}` : cta_url;
  let text = draft.text.trim();
  if (brief.include_link) {
    text = text.includes(LINK_PLACEHOLDER) ? text.replace(LINK_PLACEHOLDER, link) : `${text}\n\n${link}`;
  } else {
    text = text.replaceAll(LINK_PLACEHOLDER, "").trim();
  }
  return { ...draft, text };
}

export function weightedLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}
