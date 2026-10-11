// Marketer: decides the next post. Goal, play, angle and format, and for images the concept the designer will build.
// It sees the product, the posting history with the results X reported, and the ideas the owner vetoed.
import { z } from "zod";
import { discardedPosts } from "../core/db/index.ts";
import type { PostRow, Product } from "../core/types.ts";
import { Brief, Goal, KIND_FORMAT, MediaKind, Play } from "../core/types.ts";
import { callJson } from "../llm.ts";
import { historyContext, historyStats, productContext, resultsContext, statsContext, vetoContext } from "./context.ts";
import { GOAL_GUIDE, PLAY_GUIDE, X_RULES } from "./playbook.ts";

export interface MarketerInput {
  product: Product;
  history: PostRow[];
  /** Angles rejected as duplicates; the marketer must pick something different. */
  avoid?: string[];
  postId?: number;
}

const KIND_GUIDE: Record<MediaKind, string> = {
  none: "text only. Best for sharp opinions, stories, questions and tips that land in words alone.",
  design:
    "an image a designer builds from scratch from your concept, in the brand's style. Describe the concept in `visual`: " +
    "a concrete scene or artifact (a ticket, a diff, a chat, a checklist, a before/after, a chart, a meme-style setup) with " +
    "attitude: irony, a jab at the old way, the joke the audience already makes. The designer can also generate a photo or " +
    "illustration for it. Never a slide with a title.",
  video:
    "a video a motion designer cuts from your concept: animated type and graphics in the brand's style, real-looking " +
    "footage and pictures generated for it, product clips, music. It autoplays muted, so the story must read on screen. " +
    "Describe in `visual` the story beat by beat (6-20 s): what we see, what the words say, the payoff. Best for a small " +
    "story, a before/after that plays out in time, or a physical scene that a still can't carry.",
};

export async function planBrief(input: MarketerInput): Promise<Brief> {
  const { product, history, avoid = [] } = input;
  const c = product.config;
  const pillarIds = c.pillars.map((p) => p.id) as [string, ...string[]];
  const stats = historyStats(product, history);
  const linkAllowed = stats.linkRatio < c.links.max_link_ratio;

  const schema = Brief.extend({
    pillar: z.enum(pillarIds),
  }).refine((b) => b.media_kind === "none" || b.visual, "visual is required when media_kind is design or video");

  const prompt = `You are the head of marketing for ${c.name}, running its X (Twitter) account to grow an audience of
${c.audience}
and turn the right people into users. You decide the single next post; a copywriter writes it, and a designer makes
its image or a motion designer its video from your concept.

${productContext(product)}

# How X works for this account
${X_RULES.map((r) => `- ${r}`).join("\n")}

# Goals
${Goal.options.map((g) => `- ${g}: ${GOAL_GUIDE[g]}`).join("\n")}

# Plays
${Play.options.map((p) => `- ${p}: ${PLAY_GUIDE[p]}`).join("\n")}

# Recent posts (newest first)
${historyContext(history)}

# What the audience responded to
${resultsContext(history)}

# Ideas the owner vetoed (they did not want these; stay away from their angle, tone and approach)
${vetoContext(discardedPosts(c.slug))}

# Stats
${statsContext(product, stats)}

# Media kinds
${MediaKind.options.map((k) => `- ${k} (format ${KIND_FORMAT[k]}): ${KIND_GUIDE[k]}`).join("\n")}
${avoid.length ? `\n# Angles already rejected as repeats: pick a clearly different idea\n${avoid.map((a) => `- ${a}`).join("\n")}` : ""}

# How to decide
1. Goal: lean toward the most under-served goal in the stats, unless the results say another goal is working much better.
2. Play: pick the play that serves the goal best; do not repeat any of the last two plays.
3. Insight first: name the belief, frustration or desire in the reader's head, then an angle that plays on it. The
   angle must not repeat a recent or vetoed post (same point in different words counts as a repeat). The post is
   about the reader's world; the product shows up only when the goal is conversion or it truly helps.
   Vary the examples: the knowledge base's sample tickets are one illustration, not the only one. For the reader's
   world (reach and engagement posts) use realistic everyday situations from their job that recent posts have not
   used; they may be made up as long as they claim nothing about the product, its users or real companies. Anything
   said about the product itself comes only from the knowledge base.
4. Pillar: the one this angle belongs to; across posts, follow the pillar weights roughly.
5. Format: the one the idea deserves, nudged by the format deficit; avoid the same format 3 times in a row. Text must
   stand alone; choose an image or video only when it carries something the words can't.
6. For media_kind design, fill visual: the concept (what is on it, why someone stops and screenshots it), the exact
   words (as few as possible), and the aspect (portrait or square fill more of a phone screen; landscape suits wide
   scenes like diffs or side-by-sides). For media_kind video, visual.concept is the story beat by beat and words are
   the lines on screen.
7. include_link: ${linkAllowed ? "true only for conversion posts that invite the reader to try the product" : "must be false (link quota reached)"}.
8. The post is in ${c.language}.`;

  const brief = await callJson(schema, prompt, { stage: "marketer", model: "opus", postId: input.postId, timeoutMs: 400_000 });
  return normalizeBrief(brief, linkAllowed);
}

/** Enforce constraints the model might bend: kind availability, matching format, required fields. */
export function normalizeBrief(brief: Brief, linkAllowed: boolean): Brief {
  const b = { ...brief };
  if (b.media_kind !== "none" && !b.visual) throw new Error(`the marketer chose ${b.media_kind} without a visual concept`);
  if (b.media_kind === "none") delete b.visual;
  b.format = KIND_FORMAT[b.media_kind];
  if (!linkAllowed || b.goal !== "conversion") b.include_link = false;
  return b;
}
