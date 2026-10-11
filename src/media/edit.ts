// The video edit the editor agent writes: a timeline of HTML/CSS scenes, video clips and audio on one canvas,
// rendered by the Edit composition (remotion/src/Edit.tsx). Files are referenced by name (`asset:<name>` in html/css,
// the bare name in `src`); this module validates the timeline and turns it into composition props.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { EditProps, Layer } from "../../remotion/src/types.ts";
import type { Product } from "../core/types.ts";
import { logoFile, resolveFonts } from "./brand.ts";
import { designKit } from "./design.ts";
import { FPS, getBundle, stageAssets } from "./video.ts";

export const VIDEO_CANVAS = {
  landscape: { w: 1920, h: 1080 },
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
} as const;
export type VideoCanvas = keyof typeof VIDEO_CANVAS;

export const MIN_SECONDS = 5;
export const MAX_SECONDS = 60;

const Time = z.number().min(0);
const Box = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), radius: z.number().min(0).optional() });

export const Timeline = z.object({
  canvas: z.enum(["landscape", "square", "portrait"]),
  duration: z.number().min(MIN_SECONDS).max(MAX_SECONDS).describe("Total seconds"),
  css: z.string().describe("One stylesheet for every html layer (classes, @keyframes)"),
  layers: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("html"),
          start: Time,
          duration: z.number().positive(),
          html: z.string().describe("Markup of a full-canvas scene; images as <img src=\"asset:<name>\">"),
        }),
        z.object({
          kind: z.literal("video"),
          start: Time,
          duration: z.number().positive(),
          src: z.string().describe("Name of a video file"),
          trim: Time.default(0).describe("Seconds skipped at the start of the file"),
          box: Box.optional().describe("Where it sits; the whole canvas when omitted"),
          fit: z.enum(["cover", "contain"]).default("cover"),
          volume: z.number().min(0).max(1).default(1).describe("Its own sound"),
          fadeIn: Time.default(0),
          fadeOut: Time.default(0),
          zoom: z.tuple([z.number().positive(), z.number().positive()]).default([1, 1]).describe("Scale at start and end"),
        }),
        z.object({
          kind: z.literal("audio"),
          start: Time,
          duration: z.number().positive(),
          src: z.string().describe("Name of an audio file"),
          trim: Time.default(0),
          volume: z.number().min(0).max(1).default(0.8),
          fadeIn: Time.default(0.3),
          fadeOut: Time.default(1),
        }),
      ]),
    )
    .min(1)
    .describe("Bottom to top: later layers draw over earlier ones"),
});
export type Timeline = z.infer<typeof Timeline>;

const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac)$/i;

/** Problems that make the timeline unrenderable or broken, phrased for the editor. Empty = fine. */
export function timelineProblems(t: Timeline, files: Record<string, string>): string[] {
  const p: string[] = [];
  const end = (l: { start: number; duration: number }) => l.start + l.duration;
  t.layers.forEach((l, i) => {
    const name = `layer ${i} (${l.kind})`;
    if (end(l) > t.duration + 0.05) p.push(`${name} ends at ${end(l).toFixed(2)}s, after the video (${t.duration}s)`);
    if (l.kind === "video" && !(files[l.src] && VIDEO_EXT.test(files[l.src]!))) p.push(`${name}: "${l.src}" is not one of the video files`);
    if (l.kind === "audio" && !(files[l.src] && (AUDIO_EXT.test(files[l.src]!) || VIDEO_EXT.test(files[l.src]!)))) p.push(`${name}: "${l.src}" is not one of the audio files`);
  });
  for (const s of [t.css, ...t.layers.flatMap((l) => (l.kind === "html" ? [l.html] : []))])
    for (const m of s.matchAll(/asset:([A-Za-z0-9._-]+)/g)) if (!files[m[1]!]) p.push(`asset:${m[1]} does not exist`);
  for (const s of [t.css, ...t.layers.flatMap((l) => (l.kind === "html" ? [l.html] : []))])
    for (const m of s.matchAll(/(?:src=["']|url\(["']?)(https?:[^"')]+)/g)) p.push(`external url ${m[1]!.slice(0, 80)} will not load; use the provided assets`);
  const covered = Math.max(...t.layers.map(end));
  if (covered < t.duration - 0.05) p.push(`nothing is on screen after ${covered.toFixed(2)}s (the video lasts ${t.duration}s)`);
  return [...new Set(p)];
}

/** Brand files every edit can use: logos (by background) and font files. Written into `dir` once. */
export function brandFiles(product: Product, dir: string): Record<string, string> {
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const theme of ["dark", "light"] as const) {
    const logo = logoFile(product, theme);
    if (!logo) continue;
    const file = path.join(dir, `logo-on-${theme}${logo.ext}`);
    fs.writeFileSync(file, logo.body);
    files[path.basename(file)] = file;
  }
  return files;
}

/** The brand stylesheet for the edit: font faces (as assets), brand variables and a base for every layer. */
function brandCss(product: Product, fontNames: string[]): string {
  const { fonts } = resolveFonts(product);
  const faces = fonts.map(
    (f, i) => `@font-face{font-family:"${f.family}";src:url("asset:${fontNames[i]}");font-weight:${f.weight};font-style:${f.style};font-display:block;}`,
  );
  const vars = designKit(product).vars;
  return [
    ...faces,
    `:root{${Object.entries(vars).map(([k, v]) => `${k}:${v};`).join("")}}`,
    "*,*::before,*::after{box-sizing:border-box}",
    ".layer{font-family:var(--font-sans);overflow:hidden}",
  ].join("\n");
}

/** Composition props for a timeline: every file staged into the Remotion bundle. */
export async function editProps(t: Timeline, product: Product, files: Record<string, string>): Promise<EditProps> {
  const { w, h } = VIDEO_CANVAS[t.canvas];
  const { fonts } = resolveFonts(product);
  const fontFiles = Object.fromEntries(fonts.map((f, i) => [`font-${i}${path.extname(f.file)}`, f.file]));
  const serveUrl = await getBundle();
  const assets = stageAssets(serveUrl, { ...files, ...fontFiles });
  const layers: Layer[] = t.layers.map((l) =>
    l.kind === "video" ? { ...l, box: l.box ?? { x: 0, y: 0, width: w, height: h } } : l,
  );
  return { width: w, height: h, fps: FPS, total: t.duration, assets, css: `${brandCss(product, Object.keys(fontFiles))}\n${t.css}`, layers };
}

/** Seconds worth previewing: shortly after each layer starts, the middle, and the last frame. */
export function previewTimes(t: Timeline, max = 9): number[] {
  const starts = t.layers.filter((l) => l.kind !== "audio").map((l) => Math.min(l.start + Math.min(0.8, l.duration / 2), l.start + l.duration - 0.05));
  const all = [...new Set([...starts, t.duration / 2, t.duration - 0.05].map((x) => Math.round(x * 10) / 10))].sort((a, b) => a - b);
  if (all.length <= max) return all;
  return Array.from({ length: max }, (_, i) => all[Math.round((i * (all.length - 1)) / (max - 1))]!);
}
