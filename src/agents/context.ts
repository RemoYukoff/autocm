// Builds the shared context every agent sees: product brief, voice, knowledge and posting history.
import type { Capabilities, Format, MediaKind, PostRow, Product } from "../core/types.ts";

const DAY_MS = 86_400_000;

export function productContext(product: Product): string {
  const c = product.config;
  const clips = c.assets.clips.map((cl) => `- ${cl.id}: ${cl.description}`).join("\n") || "(none)";
  const screens = c.assets.screens.map((s) => `- ${s.id}: ${s.description}`).join("\n") || "(none)";
  return `# Product: ${c.name} (${c.url})
${c.one_liner}

## Audience
${c.audience}

## Voice rules
${c.voice.rules.map((r) => `- ${r}`).join("\n")}

## Banned phrases (never use)
${c.voice.banned_phrases.join(", ") || "(none)"}

## Example posts in the right voice
${c.voice.example_posts.map((p) => `> ${p}`).join("\n")}

## Content pillars
${c.pillars.map((p) => `- ${p.id} (weight ${p.weight}): ${p.description}`).join("\n")}

## Video clips available (for media_kind "clip")
${clips}

## Screenshots available (for template "screenshot")
${screens}

## Knowledge base (source of truth; never claim anything not supported here)
${product.knowledge}`;
}

export interface HistoryStats {
  /** Share of each format among posts of the last 14 days. */
  share: Record<Format, number>;
  /** target − actual share; positive means under-posted. */
  deficit: Record<Format, number>;
  pillarCounts: Record<string, number>;
  lastFormats: Format[];
  linkRatio: number;
  total: number;
}

export function historyStats(product: Product, history: PostRow[], now = Date.now()): HistoryStats {
  const recent = history.filter((p) => now - Date.parse(p.published_at ?? p.created_at) <= 14 * DAY_MS);
  const formats: Format[] = ["text", "image", "video"];
  const mix = product.config.format_mix;
  const mixTotal = mix.text + mix.image + mix.video;
  const counts = Object.fromEntries(formats.map((f) => [f, recent.filter((p) => p.format === f).length])) as Record<Format, number>;
  const n = recent.length;
  const share = Object.fromEntries(formats.map((f) => [f, n ? counts[f] / n : 0])) as Record<Format, number>;
  const deficit = Object.fromEntries(formats.map((f) => [f, mix[f] / mixTotal - share[f]])) as Record<Format, number>;
  const pillarCounts: Record<string, number> = {};
  for (const p of recent) if (p.pillar) pillarCounts[p.pillar] = (pillarCounts[p.pillar] ?? 0) + 1;
  const last10 = history.slice(0, 10);
  const withLink = last10.filter((p) => p.text && /https?:\/\//.test(p.text)).length;
  return {
    share,
    deficit,
    pillarCounts,
    lastFormats: history.slice(0, 3).map((p) => p.format).filter((f): f is Format => Boolean(f)),
    linkRatio: last10.length ? withLink / last10.length : 0,
    total: n,
  };
}

/** "/meme/light" for template posts, so the strategist can see which cards it already used. */
function cardOf(p: PostRow): string {
  if (p.media_kind !== "template" || !p.brief_json) return "";
  try {
    const b = JSON.parse(p.brief_json) as { template_id?: string; theme?: string };
    return [b.template_id, b.theme].filter(Boolean).map((x) => `/${x}`).join("");
  } catch {
    return "";
  }
}

export function historyContext(history: PostRow[], limit = 30): string {
  if (!history.length) return "(no posts yet — this is the first one)";
  return history
    .slice(0, limit)
    .map((p) => {
      const when = (p.published_at ?? p.created_at).slice(0, 10);
      const text = (p.text ?? "").replace(/\s+/g, " ").slice(0, 160);
      return `- ${when} [${p.format}/${p.media_kind}${cardOf(p)}] pillar=${p.pillar} angle="${p.angle}" text="${text}"`;
    })
    .join("\n");
}

/** Media kinds that can actually be produced right now. */
export function availableKinds(caps: Capabilities): MediaKind[] {
  const all: MediaKind[] = ["none", "template", "ai_image", "remotion", "clip", "ai_video"];
  return all.filter((k) => k === "none" || caps[k as keyof Capabilities]);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function statsContext(product: Product, stats: HistoryStats): string {
  const mix = product.config.format_mix;
  const mixTotal = mix.text + mix.image + mix.video;
  return `Posts in the last 14 days: ${stats.total}
Format target mix: text ${pct(mix.text / mixTotal)}, image ${pct(mix.image / mixTotal)}, video ${pct(mix.video / mixTotal)}
Actual mix (14 days): text ${pct(stats.share.text)}, image ${pct(stats.share.image)}, video ${pct(stats.share.video)}
Deficit (positive = under-posted, prefer it): text ${pct(stats.deficit.text)}, image ${pct(stats.deficit.image)}, video ${pct(stats.deficit.video)}
Last formats (newest first): ${stats.lastFormats.join(", ") || "(none)"}
Pillar usage (14 days): ${Object.entries(stats.pillarCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}
Share of last 10 posts with a link: ${pct(stats.linkRatio)} (max allowed ${pct(product.config.links.max_link_ratio)})`;
}
