// Remotion renders from Node: bundle once per process, stage assets into the bundle's public dir,
// render H.264 + AAC, remux with faststart, then probe and pull preview frames.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { ClipCaptionProps, KineticProps, BrandProps as RemotionBrand, Word as RemotionWord } from "../../remotion/src/types.ts";
import { REMOTION_DIR } from "../core/paths.ts";
import type { MediaFile, Product, VideoCopy } from "../core/types.ts";
import { resolveBrand, type Brand } from "./brand.ts";
import { headlessShellPath } from "./browser.ts";
import { parseHighlights, planBeats, toWords } from "./copy.ts";
import { extractFrames } from "./frames.ts";
import { checkVideo, probeVideo, type VideoProbe } from "./qa.ts";

const run = promisify(execFile);

export type VideoSize = "square" | "landscape";
export const VIDEO_SIZES: Record<VideoSize, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  landscape: { w: 1920, h: 1080 },
};
export const FPS = 30;
/** X allows 140 s; leave headroom for the end card. */
export const MAX_VIDEO_SECONDS = 140;

let bundlePromise: Promise<string> | null = null;

/** Webpack bundle of remotion/src, built once per process. */
export function getBundle(): Promise<string> {
  bundlePromise ??= bundle({
    entryPoint: path.join(REMOTION_DIR, "src", "index.ts"),
    onProgress: () => {},
  })
    .then((dir) => {
      // Each process bundles into a fresh temp dir (webpack's cache keeps it fast); remove it on exit.
      process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
      return dir;
    })
    .catch((e) => {
      bundlePromise = null;
      throw e;
    });
  return bundlePromise;
}

/** Copy (hard-link when possible) a file into <bundle>/public/autocm/ and return its staticFile path. */
function stage(serveUrl: string, file: string): string {
  const dir = path.join(serveUrl, "public", "autocm");
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statSync(file);
  const key = crypto.createHash("sha1").update(`${path.resolve(file)}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 16);
  const name = `${key}${path.extname(file).toLowerCase()}`;
  const dest = path.join(dir, name);
  if (!fs.existsSync(dest)) {
    try {
      fs.linkSync(file, dest);
    } catch {
      fs.copyFileSync(file, dest);
    }
  }
  return `autocm/${name}`;
}

function remotionBrand(b: Brand, serveUrl: string): RemotionBrand {
  return {
    name: b.name,
    host: b.host,
    logo: b.logo,
    colors: { bg: b.colors.bg, fg: b.colors.fg, muted: b.colors.muted, hl: b.colors.hl, primary: b.colors.primary, accent: b.colors.accent },
    sans: b.sansStack,
    mono: b.monoStack,
    fonts: b.fonts.map((f) => ({ family: f.family, src: stage(serveUrl, f.file), weight: f.weight, style: f.style })),
  };
}

export interface VideoOutput {
  file: MediaFile;
  probe: VideoProbe;
  issues: string[];
  frames: string[];
  notes: string[];
  ms: number;
}

async function renderComposition(
  id: "KineticText" | "ClipCaption",
  inputProps: KineticProps | ClipCaptionProps,
  serveUrl: string,
  outPath: string,
): Promise<VideoOutput> {
  const t0 = Date.now();
  const browserExecutable = headlessShellPath();
  const props = inputProps as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id, inputProps: props, browserExecutable, logLevel: "error" });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const raw = `${outPath}.raw.mp4`;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    pixelFormat: "yuv420p",
    crf: 18,
    x264Preset: "medium",
    audioCodec: "aac",
    enforceAudioTrack: true,
    // bt709 = limited (tv) range, tagged; the default emits full-range yuvj420p, which some players and X re-encodes misread.
    colorSpace: "bt709",
    inputProps: props,
    outputLocation: raw,
    overwrite: true,
    browserExecutable,
    logLevel: "error",
  });
  // Uniform container: H.264 copied, AAC stereo 48 kHz, moov atom first.
  await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", outPath]);
  fs.rmSync(raw, { force: true });

  const probe = await probeVideo(outPath);
  const issues = checkVideo(probe, { width: inputProps.width, height: inputProps.height });
  const frames = await extractFrames(outPath, probe.duration, path.join(path.dirname(outPath), "frames"));
  const ms = Date.now() - t0;
  return {
    file: { path: path.resolve(outPath), mime: "video/mp4", width: probe.width, height: probe.height, bytes: probe.bytes, duration_s: Math.round(probe.duration * 100) / 100 },
    probe,
    issues,
    frames,
    notes: [`${id} ${probe.width}x${probe.height} ${probe.duration.toFixed(1)}s rendered in ${(ms / 1000).toFixed(1)}s`],
    ms,
  };
}

export async function renderKinetic(copy: VideoCopy, product: Product, outPath: string, size: VideoSize = "square"): Promise<VideoOutput> {
  const serveUrl = await getBundle();
  const brand = resolveBrand(product, "dark");
  const plan = planBeats(copy, { host: brand.host });
  const { w, h } = VIDEO_SIZES[size];
  const props: KineticProps = { width: w, height: h, fps: FPS, brand: remotionBrand(brand, serveUrl), ...plan };
  const out = await renderComposition("KineticText", props, serveUrl, outPath);
  out.notes.unshift(...brand.notes.filter((n) => !n.startsWith("no ")));
  return out;
}

/** Source video duration and size via ffprobe. */
export async function probeSource(file: string): Promise<{ duration: number; width: number; height: number }> {
  const p = await probeVideo(file);
  return { duration: p.duration, width: p.width, height: p.height };
}

export async function renderClipCaption(
  clipFile: string,
  copy: VideoCopy,
  product: Product,
  outPath: string,
  trim: { start?: number; end?: number } = {},
): Promise<VideoOutput> {
  const src = await probeSource(clipFile);
  if (!(src.duration > 0)) throw new Error(`clip has no duration: ${clipFile}`);
  const endCard = 2.4;
  const intro = 1.8;
  const start = Math.min(Math.max(0, trim.start ?? 0), Math.max(0, src.duration - 0.5));
  const end = Math.min(src.duration, trim.end ?? src.duration);
  // Stop ~0.15 s short of the source end: the crossfade into the end card overlaps a few frames.
  const duration = Math.max(0.5, Math.min(end - start - 0.15, MAX_VIDEO_SECONDS - intro - endCard - 0.5));
  // Landscape sources keep 16:9, everything else renders square.
  const size: VideoSize = src.width >= src.height * 1.3 ? "landscape" : "square";
  const { w, h } = VIDEO_SIZES[size];

  const serveUrl = await getBundle();
  const brand = resolveBrand(product, "dark");
  const headline: RemotionWord[] = toWords(parseHighlights(copy.headline, copy.highlight_words));
  const props: ClipCaptionProps = {
    width: w,
    height: h,
    fps: FPS,
    brand: remotionBrand(brand, serveUrl),
    clip: { src: stage(serveUrl, clipFile), trimBefore: start, duration },
    headline,
    intro,
    endCard,
    total: Math.round((intro + duration + endCard) * 100) / 100,
  };
  return renderComposition("ClipCaption", props, serveUrl, outPath);
}
