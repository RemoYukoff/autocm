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
  start: z.number().nonnegative().optional(),
  end: z.number().positive().optional(),
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

// ---------- Capabilities ----------

export const Format = z.enum(["text", "image", "video"]);
export type Format = z.infer<typeof Format>;

export const MediaKind = z.enum(["none", "template", "ai_image", "remotion", "clip", "ai_video"]);
export type MediaKind = z.infer<typeof MediaKind>;

export const TemplateId = z.enum(["statement", "poster", "meme", "chat", "diff", "comparison", "stat", "checklist", "screenshot"]);
export type TemplateId = z.infer<typeof TemplateId>;

export interface Capabilities {
  template: boolean;
  remotion: boolean;
  clip: boolean;
  ai_image: boolean;
  ai_video: boolean;
  /** The product has a connected X session, so it can publish. */
  live: boolean;
}

export const KIND_FORMAT: Record<MediaKind, Format> = {
  none: "text",
  template: "image",
  ai_image: "image",
  remotion: "video",
  clip: "video",
  ai_video: "video",
};

// ---------- Stage contracts ----------

export const Brief = z.object({
  pillar: z.string(),
  angle: z.string().describe("The specific idea of this post, one sentence"),
  hook_idea: z.string().describe("How the first line grabs attention"),
  format: Format,
  media_kind: MediaKind,
  template_id: TemplateId.optional().describe("Required when media_kind is template"),
  clip_id: z.string().optional().describe("Required when media_kind is clip"),
  screen_id: z.string().optional().describe("Optional screenshot for the screenshot template"),
  theme: z.enum(["dark", "light"]).optional().describe("Required when media_kind is template: card background"),
  include_link: z.boolean(),
  visual_direction: z.string().optional().describe("For ai_image / ai_video: what the visual should show"),
  rationale: z.string().describe("Why this pillar, angle and format now"),
});
export type Brief = z.infer<typeof Brief>;

export const MediaCopy = z.object({
  headline: z.string().describe("Main text on the image/video; may wrap *words* to highlight"),
  lines: z.array(z.string()).default([]).describe("Supporting lines, bullets, comparison rows or video beats"),
  highlight_words: z.array(z.string()).default([]),
  kicker: z.string().optional().describe("Small label above the headline, e.g. 'Hot take', 'POV', 'Unpopular opinion'"),
  stat: z.string().optional().describe("Big number for the stat template, e.g. '~$1.30'"),
  left_label: z.string().optional().describe("Comparison template left column title"),
  right_label: z.string().optional().describe("Comparison template right column title"),
});
export type MediaCopy = z.infer<typeof MediaCopy>;

export const Draft = z.object({
  text: z.string().describe("Tweet text, <=280 weighted chars"),
  alt_text: z.string().optional().describe("Alt text for image/video, <=1000 chars"),
  media_copy: MediaCopy.optional(),
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
  /** Set when the requested kind failed and a fallback kind was used. */
  fallback_from: MediaKind.optional(),
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
}

export interface PublishResult {
  tweet_id: string;
  url: string;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}
