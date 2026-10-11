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
  statement: "headline: one bold claim (max ~10 words), the line someone would quote. lines: 0-1 short supporting line.",
  poster: 'headline: the hot take itself, max ~8 words, as blunt as the facts allow. Cross out the wrong word with ~tildes~ and highlight the right one, e.g. "Your AI doesn\'t ~test~. It *guesses*." lines: 0-1 short deadpan follow-up (max ~6 words). kicker: e.g. "Hot take", "Unpopular opinion".',
  meme: 'lines: 2-5 rows "Who: text" in a known text-meme shape ("Nobody:" with empty text, "PM:", "QA at 6pm Friday:", "Expectation:/Reality:", "Day 1:/Day 30:"). The last row is the punchline; highlight its key words. headline: empty, or a short setup like "Every sprint:". Keep each row under ~10 words.',
  chat: 'lines: 3-6 messages "Role: message" between 2-3 roles (PM, QA, Dev, "The AI"...), like a real Slack thread: short, lowercase is fine, "..." allowed. The second role is the hero shown on the right; the last message is the zinger. headline: usually empty. kicker: optional context, e.g. "Release day", "#qa-team".',
  diff: 'left_label: a file-like name (e.g. "TC-142 apply-discount.md", "sprint-habits.diff"). lines: 3-7 lines, "- " for removed, "+ " for added, no prefix for context, each max ~8 words: show the bad version being replaced by the good one. headline: the takeaway (max ~10 words).',
  comparison: 'left_label and right_label: column titles (1-3 words; left is the old way, right is the product or the right way). lines: 3-5 rows formatted exactly "left | right", each side max ~6 words; the left side gets crossed out. headline: the verdict, not a topic title (e.g. "Fast is easy. *Right* is the product.", not "Two kinds of question").',
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
Wrap 1-2 key words in *asterisks* to highlight them (marker stroke) and list them in highlight_words; ~tildes~ cross words out.
The image copy is short and punchy: written for someone scrolling, readable in two seconds. Same facts and claims rules
as the tweet, but more attitude: irony, a jab at the old way, the joke the audience already makes. Never a topic label.
kicker (optional): a 1-3 word sticker above the headline ("Hot take", "POV", "Unpopular opinion"); omit when it adds nothing.` : "- This is a text-only post: omit alt_text and media_copy."}
${previous ? `\n# Previous draft (rejected)\n${JSON.stringify(previous, null, 2)}` : ""}
${feedback.length ? `\n# Fix these issues\n${feedback.map((f) => `- ${f}`).join("\n")}` : ""}`;

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
