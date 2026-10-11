// Shared contracts between pipeline stages. Change only on main; streams rebase.
import { z } from "zod";

// ---------- Product config (products/<slug>/product.yaml) ----------

const hhmm = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "window must look like 09:00-11:00");

export const Pillar = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  weight: z.number().positive(),
});
export type Pillar = z.infer<typeof Pillar>;

export const Clip = z.object({
  id: z.string(),
  path: z.string().describe("Relative to products/<slug>/"),
  description: z.string(),
});
export type Clip = z.infer<typeof Clip>;

export const Screen = z.object({
  id: z.string(),
  path: z.string().describe("Relative to products/<slug>/"),
  description: z.string(),
});
export type Screen = z.infer<typeof Screen>;

export const ProductConfig = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  url: z.url(),
  enabled: z.boolean().default(true),
  language: z.string().default("en"),
  timezone: z.string().default("America/New_York"),
  one_liner: z.string(),
  audience: z.string(),
  voice: z.object({
    rules: z.array(z.string()).min(1),
    banned_phrases: z.array(z.string()).default([]),
    example_posts: z.array(z.string()).default([]),
  }),
  pillars: z.array(Pillar).min(1),
  format_mix: z
    .object({ text: z.number().min(0), image: z.number().min(0), video: z.number().min(0) })
    .refine((m) => m.text + m.image + m.video > 0, "format_mix must not be all zero"),
  cadence: z
    .object({
      posts_per_day_min: z.number().int().min(0).max(10).describe("Fewest posts planned for one day"),
      posts_per_day_max: z.number().int().min(0).max(10).describe("Most posts planned for one day; each day draws a count in [min, max]"),
      windows: z.array(hhmm).min(1),
      daily_cap: z.number().int().min(0).max(20),
      min_gap_min: z.number().int().min(0).default(90),
    })
    .refine((c) => c.posts_per_day_min <= c.posts_per_day_max, "posts_per_day_min must be <= posts_per_day_max"),
  brand: z.object({
    colors: z.object({
      primary: z.string(),
      accent: z.string(),
      ink: z.string(),
      bg: z.string(),
      muted: z.string().optional(),
    }),
    fonts: z.object({
      sans: z.string(),
      mono: z.string().optional(),
      files: z.array(z.string()).default([]).describe("woff2 paths relative to products/<slug>/"),
    }),
    logo: z.string().describe("Path relative to products/<slug>/"),
    guidelines: z.array(z.string()).min(1).describe("Design manual for the designer: look, mood, layout habits, do's and don'ts"),
    reference: z.string().describe("Screenshot of the product's website (path relative to products/<slug>/), the designer's visual reference"),
  }),
  assets: z
    .object({
      clips: z.array(Clip).default([]),
      screens: z.array(Screen).default([]),
    })
    .default({ clips: [], screens: [] }),
  links: z.object({
    cta_url: z.url(),
    utm: z.string().optional(),
    max_link_ratio: z.number().min(0).max(1).default(0.34).describe("Max share of recent posts carrying a link"),
  }),
  hashtags: z
    .object({ max_per_post: z.number().int().min(0).default(1) })
    .default({ max_per_post: 1 }),
});
export type ProductConfig = z.infer<typeof ProductConfig>;

/** Loaded product: config plus resolved paths, knowledge and its connected X account. */
export interface Product {
  config: ProductConfig;
  dir: string;
  knowledge: string;
  /** X account logged in through the browser (row in x_accounts and a profile in data/sessions/<slug>/), or null. */
  xAccount: XAccount | null;
}

export interface XAccount {
  product: string;
  handle: string;
  name: string | null;
  /** Absolute path of the downloaded avatar, if any. */
  avatar_path: string | null;
  connected_at: string;
  /** Last time a browser operation confirmed the session is still logged in. */
  last_ok_at: string | null;
  /** Last session problem (e.g. logged out), cleared on success. */
  error: string | null;
}

/** Profile read from the logged-in X session. */
export interface XProfile {
  handle: string;
  name: string | null;
  avatar_url: string | null;
}

// ---------- Formats ----------

export const Format = z.enum(["text", "image", "video"]);
export type Format = z.infer<typeof Format>;

/**
 * none: text only. design: an image the designer agent builds from scratch. video: a video the editor agent cuts
 * from animated brand scenes, ElevenLabs footage/pictures/music and product clips.
 */
export const MediaKind = z.enum(["none", "design", "video"]);
export type MediaKind = z.infer<typeof MediaKind>;

export const KIND_FORMAT: Record<MediaKind, Format> = {
  none: "text",
  design: "image",
  video: "video",
};

// ---------- Stage contracts ----------

/** What the post is for. The marketer balances these over time (src/agents/playbook.ts). */
export const Goal = z.enum(["reach", "engagement", "conversion"]);
export type Goal = z.infer<typeof Goal>;

/** The kind of post, from the marketing playbook (src/agents/playbook.ts). */
export const Play = z.enum([
  "hot_take",
  "relatable_pain",
  "story",
  "how_to",
  "teardown",
  "myth_vs_reality",
  "list",
  "question",
  "product_moment",
  "offer",
]);
export type Play = z.infer<typeof Play>;

export const ImageAspect = z.enum(["landscape", "square", "portrait"]);
export type ImageAspect = z.infer<typeof ImageAspect>;

/** The marketer's creative brief for the designer (image) or the editor (video): what it shows and says, not how. */
export const Visual = z.object({
  concept: z.string().describe("Image: what it shows and why it stops the scroll (the joke, the contrast, the scene). Video: the story beat by beat. Concrete, not a mood board"),
  words: z.string().describe("The words that must appear on it, as few as possible"),
  aspect: ImageAspect.describe("landscape 16:9, square 1:1 or portrait 4:5 (portrait and square take more of a phone screen)"),
});
export type Visual = z.infer<typeof Visual>;

export const Brief = z.object({
  goal: Goal,
  play: Play,
  pillar: z.string(),
  insight: z.string().describe("The belief, frustration or desire in the reader's head that this post plays on"),
  angle: z.string().describe("The specific idea of this post, one sentence"),
  hook_idea: z.string().describe("How the first line grabs attention"),
  format: Format,
  media_kind: MediaKind,
  visual: Visual.optional().describe("Required when media_kind is design or video"),
  include_link: z.boolean(),
  rationale: z.string().describe("Why this goal, play, angle and format now"),
});
export type Brief = z.infer<typeof Brief>;

export const Draft = z.object({
  text: z.string().describe("Tweet text, <=280 weighted chars"),
});
export type Draft = z.infer<typeof Draft>;

export const MediaFile = z.object({
  path: z.string().describe("Absolute path"),
  mime: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  duration_s: z.number().optional(),
});
export type MediaFile = z.infer<typeof MediaFile>;

export const MediaResult = z.object({
  kind: MediaKind,
  files: z.array(MediaFile),
  /** PNG previews (dashboard): the image itself, or ~5 video frames. */
  preview_frames: z.array(z.string()).default([]),
  /** Description for screen readers (designed images and videos). */
  alt_text: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type MediaResult = z.infer<typeof MediaResult>;

export const PostStatus = z.enum([
  "generating",
  "approved",
  "publishing",
  "published",
  "failed",
]);
export type PostStatus = z.infer<typeof PostStatus>;

export interface PostRow {
  id: number;
  product: string;
  slot_id: number | null;
  status: PostStatus;
  goal: Goal | null;
  play: Play | null;
  pillar: string | null;
  angle: string | null;
  format: Format | null;
  media_kind: MediaKind | null;
  text: string | null;
  alt_text: string | null;
  media_json: string | null;
  brief_json: string | null;
  attempts: number;
  text_hash: string | null;
  tweet_id: string | null;
  url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  /** Engagement read back from X after publishing (null until first read). */
  views: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  metrics_at: string | null;
}

export interface PublishResult {
  tweet_id: string;
  url: string;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}
