// Strategist: decides pillar, angle and format (text / image / video) for the next post.
import { z } from "zod";
import type { Capabilities, Format, MediaKind, PostRow, Product } from "../core/types.ts";
import { Brief, KIND_FORMAT, TemplateId } from "../core/types.ts";
import { callJson } from "../llm.ts";
import { availableKinds, historyContext, historyStats, productContext, statsContext } from "./context.ts";

export interface StrategistInput {
  product: Product;
  caps: Capabilities;
  history: PostRow[];
  format?: Format;
  /** Angles rejected as duplicates; the strategist must pick something different. */
  avoid?: string[];
  postId?: number;
}

const KIND_GUIDE: Record<MediaKind, string> = {
  none: "text only. Best for sharp opinions, one-liners, questions, short stories.",
  template: `branded image card rendered from HTML. template_id: statement (one bold line + support), comparison (two columns, rows "left | right"), stat (one big number), checklist (3-6 items), screenshot (product screenshot in a frame; set screen_id).`,
  ai_image: "AI-generated illustration with the headline on top. Set visual_direction. Use sparingly; abstract/conceptual visuals only, never fake product UI.",
  remotion: "short kinetic-typography video (6-15 s) built from a headline and 3-5 beats. Great for a mini narrative: problem → turn → payoff.",
  clip: "a real product clip from the available list with an animated caption. Set clip_id. Best for showing the product working.",
  ai_video: "AI-generated video clip. Expensive; only for a strong visual idea.",
};

export async function planBrief(input: StrategistInput): Promise<Brief> {
  const { product, caps, history, format, avoid = [] } = input;
  const kinds = availableKinds(caps, format);
  const formats = [...new Set(kinds.map((k) => KIND_FORMAT[k]))] as [Format, ...Format[]];
  const pillarIds = product.config.pillars.map((p) => p.id) as [string, ...string[]];
  const stats = historyStats(product, history);
  const linkAllowed = stats.linkRatio < product.config.links.max_link_ratio;

  const schema = Brief.extend({
    pillar: z.enum(pillarIds),
    format: z.enum(formats),
    media_kind: z.enum(kinds as [MediaKind, ...MediaKind[]]),
    clip_id: caps.clip ? z.enum(product.config.assets.clips.map((c) => c.id) as [string, ...string[]]).optional() : z.string().optional(),
  });

  const prompt = `You are the content strategist for ${product.config.name}'s X (Twitter) account. Decide the single next post.

${productContext(product)}

# Recent posts (newest first)
${historyContext(history)}

# Stats
${statsContext(product, stats)}

# Media kinds you can use now
${kinds.map((k) => `- ${k} (format ${KIND_FORMAT[k]}): ${KIND_GUIDE[k]}`).join("\n")}
${format ? `\nThe format for this post is fixed: ${format}.` : ""}
${avoid.length ? `\n# Angles already rejected — pick a clearly different idea\n${avoid.map((a) => `- ${a}`).join("\n")}` : ""}

# How to decide
1. Pick the pillar most under-used relative to its weight, unless a different one gives a clearly stronger idea.
2. Pick an angle that is NOT a repeat of any recent post (same idea with different words counts as a repeat).
3. Choose the format the idea deserves, nudged by the format deficit; avoid the same format 3 times in a row.
   A text post must stand alone; choose image/video only when the visual adds something the text can't.
4. include_link: ${linkAllowed ? "true only if the post is a direct invitation to try the product" : "must be false (link quota reached)"}.
5. The post must be in ${product.config.language}. Write for the audience, not for the founder.
6. Template ids: ${TemplateId.options.join(", ")}. Set template_id only for media_kind template.`;

  const brief = await callJson(schema, prompt, { stage: "strategist", model: "sonnet", postId: input.postId });
  return normalizeBrief(brief, caps, product, linkAllowed);
}

/** Enforce constraints the model might bend: kind availability, matching format, required ids. */
export function normalizeBrief(brief: Brief, caps: Capabilities, product: Product, linkAllowed: boolean): Brief {
  const b = { ...brief };
  if (b.media_kind === "ai_image" && !caps.ai_image) b.media_kind = "template";
  if (b.media_kind === "ai_video" && !caps.ai_video) b.media_kind = "remotion";
  if (b.media_kind === "clip" && !product.config.assets.clips.some((c) => c.id === b.clip_id)) b.media_kind = "remotion";
  if (b.media_kind === "template" && !b.template_id) b.template_id = "statement";
  if (b.template_id === "screenshot" && !product.config.assets.screens.some((s) => s.id === b.screen_id)) {
    b.screen_id = product.config.assets.screens[0]?.id;
    if (!b.screen_id) b.template_id = "statement";
  }
  if (b.media_kind !== "template") delete b.template_id;
  if (b.media_kind !== "clip") delete b.clip_id;
  b.format = KIND_FORMAT[b.media_kind];
  if (!linkAllowed) b.include_link = false;
  return b;
}
