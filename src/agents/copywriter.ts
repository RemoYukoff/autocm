// Copywriter: turns a Brief into the tweet text plus the copy that goes inside the image/video.
import twitterText from "twitter-text";
import type { Brief, Draft, PostRow, Product } from "../core/types.ts";
import { Draft as DraftSchema } from "../core/types.ts";
import { callJson } from "../llm.ts";
import { historyContext, productContext } from "./context.ts";

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

const MEDIA_COPY_GUIDE: Record<string, string> = {
  statement: "headline: one bold line (max ~12 words). lines: 0-1 short supporting line.",
  comparison: 'left_label and right_label: column titles (1-3 words). lines: 3-5 rows formatted exactly "left | right", each side max ~6 words. headline: short title.',
  stat: "stat: the big number/figure (max ~8 chars, e.g. \"~$1.30\"). headline: what the number means (max ~8 words). lines: 0-1 short context line.",
  checklist: "headline: list title (max ~7 words). lines: 3-6 items, each max ~8 words.",
  screenshot: "headline: one line describing what the screenshot shows and why it matters (max ~10 words). lines: 0-1 caption.",
  remotion: "headline: the opening beat (max ~8 words). lines: 3-5 following beats, each max ~8 words, telling a mini story: problem → turn → payoff. The last beat can be the product url.",
  clip: "headline: title card shown for ~2 s before the clip plays (max ~8 words). The clip already shows its own on-screen headline (see the clip description): never repeat it; add context the clip does not say (who it is for, why it matters). lines: leave empty.",
  ai_image: "headline: one bold line shown over the illustration (max ~10 words).",
  ai_video: "headline: caption shown over the clip (max ~8 words).",
};

export async function writeDraft(input: CopywriterInput): Promise<Draft> {
  const { product, brief, feedback = [], previous } = input;
  const c = product.config;
  const needsMedia = brief.media_kind !== "none";
  const guideKey = brief.media_kind === "template" ? (brief.template_id ?? "statement") : brief.media_kind;

  const prompt = `You write posts for ${c.name}'s X (Twitter) account.

${productContext(product)}

# Recent posts (do not repeat their hooks or phrasing)
${historyContext(input.history, 15)}

# Brief for this post
${JSON.stringify(brief, null, 2)}

# Rules for the tweet text
- Max 280 characters (URLs count as 23). Aim for 120-240. Language: ${c.language}.
- First line is the hook. Line breaks are fine. No thread, a single post.
- Follow the voice rules. Never use banned phrases. At most ${c.hashtags.max_per_post} hashtag(s); usually zero.
- Only claim what the knowledge base supports. No invented numbers, customers or quotes.
- Example posts and landing copy show the voice; never copy their lines verbatim. Write a fresh hook.
- Prefer one concrete detail (a specific rule, field, edge case or workflow step) over general statements.
- ${brief.include_link ? `Include the placeholder ${LINK_PLACEHOLDER} exactly once where the link should go (it becomes ${c.links.cta_url}).` : "Do not include any URL or link."}
${needsMedia ? `- The text must work together with the ${brief.format}, not repeat it word for word.
- alt_text: describe the ${brief.format} for screen readers (what it shows and the text on it), max 400 chars.

# Copy that goes inside the ${brief.format} (media_copy)
${MEDIA_COPY_GUIDE[guideKey] ?? MEDIA_COPY_GUIDE.statement}
Wrap 1-2 key words in *asterisks* to highlight them in brand color, and list them in highlight_words.` : "- This is a text-only post: omit alt_text and media_copy."}
${previous ? `\n# Previous draft (rejected)\n${JSON.stringify(previous, null, 2)}` : ""}
${feedback.length ? `\n# Fix these issues from review\n${feedback.map((f) => `- ${f}`).join("\n")}` : ""}`;

  const draft = await callJson(DraftSchema, prompt, { stage: "copywriter", model: "sonnet", postId: input.postId });
  return finalizeDraft(draft, brief, product);
}

/** Replace the link placeholder with the tracked URL and drop media copy on text posts. */
export function finalizeDraft(draft: Draft, brief: Brief, product: Product): Draft {
  const { cta_url, utm } = product.config.links;
  const link = utm ? `${cta_url}${cta_url.includes("?") ? "&" : "?"}${utm}` : cta_url;
  let text = draft.text.trim();
  if (brief.include_link) {
    text = text.includes(LINK_PLACEHOLDER) ? text.replace(LINK_PLACEHOLDER, link) : `${text}\n\n${link}`;
  } else {
    text = text.replaceAll(LINK_PLACEHOLDER, "").trim();
  }
  if (brief.media_kind === "none") return { text };
  return { ...draft, text };
}

export function weightedLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}
