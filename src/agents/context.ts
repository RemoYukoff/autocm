// Builds the shared context the agents see: product brief, voice, knowledge, posting history, results and vetoes.
import type { Discarded } from "../core/db/index.ts";
import type { Format, Goal, Play, PostRow, Product } from "../core/types.ts";
import { GOAL_TARGET } from "./playbook.ts";

const DAY_MS = 86_400_000;

export function productContext(product: Product): string {
  const c = product.config;
  const clips = c.assets.clips.map((cl) => `- ${cl.id}: ${cl.description}`).join("\n") || "(none)";
  const screens = c.assets.screens.map((s) => `- ${s.id}: ${s.description}`).join("\n") || "(none)";
  return `# Product: ${c.name} (${c.url})
${c.one_liner}

## Audience
${c.audience}

## Voice rules (tone, register and what may be claimed)
${c.voice.rules.map((r) => `- ${r}`).join("\n")}

## Banned phrases (never use)
${c.voice.banned_phrases.join(", ") || "(none)"}

## Example posts in the right voice
${c.voice.example_posts.map((p) => `> ${p}`).join("\n")}

## Content pillars
${c.pillars.map((p) => `- ${p.id} (weight ${p.weight}): ${p.description}`).join("\n")}

## Product clips (the motion designer can cut them into a video)
${clips}

## Product screenshots (the designer and motion designer can place them)
${screens}

## Knowledge base (source of truth; never claim anything not supported here)
${product.knowledge}`;
}

export interface HistoryStats {
  /** Share of each format among posts of the last 14 days. */
  share: Record<Format, number>;
  /** target − actual share; positive means under-posted. */
  deficit: Record<Format, number>;
  goalShare: Record<Goal, number>;
  goalDeficit: Record<Goal, number>;
  pillarCounts: Record<string, number>;
  lastFormats: Format[];
  lastPlays: Play[];
  linkRatio: number;
  total: number;
}

const GOALS: Goal[] = ["reach", "engagement", "conversion"];
const FORMATS: Format[] = ["text", "image", "video"];

export function historyStats(product: Product, history: PostRow[], now = Date.now()): HistoryStats {
  const recent = history.filter((p) => now - Date.parse(p.published_at ?? p.created_at) <= 14 * DAY_MS);
  const n = recent.length;
  const mix = product.config.format_mix;
  const mixTotal = mix.text + mix.image + mix.video;
  const shareOf = <K extends string>(keys: K[], of: (p: PostRow) => K | null) =>
    Object.fromEntries(keys.map((k) => [k, n ? recent.filter((p) => of(p) === k).length / n : 0])) as Record<K, number>;
  const share = shareOf(FORMATS, (p) => p.format);
  const goalShare = shareOf(GOALS, (p) => p.goal);
  const pillarCounts: Record<string, number> = {};
  for (const p of recent) if (p.pillar) pillarCounts[p.pillar] = (pillarCounts[p.pillar] ?? 0) + 1;
  const last10 = history.slice(0, 10);
  const withLink = last10.filter((p) => p.text && /https?:\/\//.test(p.text)).length;
  return {
    share,
    deficit: Object.fromEntries(FORMATS.map((f) => [f, mix[f] / mixTotal - share[f]])) as Record<Format, number>,
    goalShare,
    goalDeficit: Object.fromEntries(GOALS.map((g) => [g, GOAL_TARGET[g] - goalShare[g]])) as Record<Goal, number>,
    pillarCounts,
    lastFormats: history.slice(0, 3).map((p) => p.format).filter((f): f is Format => Boolean(f)),
    lastPlays: history.slice(0, 4).map((p) => p.play).filter((x): x is Play => Boolean(x)),
    linkRatio: last10.length ? withLink / last10.length : 0,
    total: n,
  };
}

/** Engagement per view: replies, reposts, quotes and bookmarks weigh double a like. */
export function engagementRate(p: PostRow): number | null {
  if (p.views === null || p.views <= 0) return null;
  return ((p.likes ?? 0) + 2 * ((p.replies ?? 0) + (p.reposts ?? 0) + (p.quotes ?? 0) + (p.bookmarks ?? 0))) / p.views;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function metricsOf(p: PostRow): string {
  if (p.metrics_at === null) return p.status === "published" ? " results=(not read yet)" : "";
  const rate = engagementRate(p);
  return ` results: ${p.views ?? 0} views, ${p.likes ?? 0} likes, ${p.replies ?? 0} replies, ${p.reposts ?? 0} reposts, ${p.quotes ?? 0} quotes, ${p.bookmarks ?? 0} bookmarks${rate === null ? "" : `, engagement ${(rate * 100).toFixed(1)}%`}`;
}

export function historyContext(history: PostRow[], limit = 30): string {
  if (!history.length) return "(no posts yet — this is the first one)";
  return history
    .slice(0, limit)
    .map((p) => {
      const when = (p.published_at ?? p.created_at).slice(0, 10);
      const text = (p.text ?? "").replace(/\s+/g, " ").slice(0, 160);
      const state = p.status === "published" ? "published" : "scheduled";
      return `- ${when} ${state} [${p.goal}/${p.play}] [${p.format}/${p.media_kind}] pillar=${p.pillar} angle="${p.angle}" text="${text}"${metricsOf(p)}`;
    })
    .join("\n");
}

/** Best and worst published posts by engagement rate, once there are enough with results to compare. */
export function resultsContext(history: PostRow[]): string {
  const rated = history
    .filter((p) => p.status === "published" && engagementRate(p) !== null)
    .map((p) => ({ p, rate: engagementRate(p)! }))
    .sort((a, b) => b.rate - a.rate);
  if (rated.length < 4) return `Only ${rated.length} published post(s) with results so far: too few to tell what works. Explore different goals, plays and formats.`;
  const line = ({ p, rate }: { p: PostRow; rate: number }) =>
    `- ${(rate * 100).toFixed(1)}% engagement, ${p.views} views [${p.goal}/${p.play}] [${p.format}/${p.media_kind}] "${(p.text ?? "").replace(/\s+/g, " ").slice(0, 120)}"`;
  const k = Math.min(3, Math.floor(rated.length / 2));
  return `Worked best:\n${rated.slice(0, k).map(line).join("\n")}\nWorked worst:\n${rated.slice(-k).map(line).join("\n")}`;
}

/** Ideas the owner discarded from the dashboard. */
export function vetoContext(vetoes: Discarded[]): string {
  if (!vetoes.length) return "(none)";
  return vetoes.map((v) => `- [${v.goal}/${v.play}] [${v.format}] angle="${v.angle}" text="${(v.text ?? "").replace(/\s+/g, " ").slice(0, 160)}"`).join("\n");
}

export function statsContext(product: Product, stats: HistoryStats): string {
  const mix = product.config.format_mix;
  const mixTotal = mix.text + mix.image + mix.video;
  const row = <K extends string>(keys: K[], v: Record<K, number>) => keys.map((k) => `${k} ${pct(v[k])}`).join(", ");
  return `Posts in the last 14 days: ${stats.total}
Goal target mix: ${row(GOALS, GOAL_TARGET)}; actual: ${row(GOALS, stats.goalShare)}; deficit (positive = under-served): ${row(GOALS, stats.goalDeficit)}
Format target mix: text ${pct(mix.text / mixTotal)}, image ${pct(mix.image / mixTotal)}, video ${pct(mix.video / mixTotal)}; actual: ${row(FORMATS, stats.share)}; deficit: ${row(FORMATS, stats.deficit)}
Last formats (newest first): ${stats.lastFormats.join(", ") || "(none)"}
Last plays (newest first): ${stats.lastPlays.join(", ") || "(none)"}
Pillar usage (14 days): ${Object.entries(stats.pillarCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}
Share of last 10 posts with a link: ${pct(stats.linkRatio)} (max allowed ${pct(product.config.links.max_link_ratio)})`;
}
