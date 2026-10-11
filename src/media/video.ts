// Remotion renders from Node: bundle once per process, stage the edit's files into the bundle's public dir, render
// stills for the editor's previews, and render the final H.264 + AAC, remuxed with faststart, probed and checked.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { EditProps } from "../../remotion/src/types.ts";
import { REMOTION_DIR } from "../core/paths.ts";
import type { MediaFile } from "../core/types.ts";
import { headlessShellPath } from "./browser.ts";
import { extractFrames } from "./frames.ts";
import { checkVideo, probeVideo, type VideoProbe } from "./qa.ts";

const run = promisify(execFile);

export const FPS = 30;

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
export function stage(serveUrl: string, file: string): string {
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

/** Stage every named file and return the asset map the composition resolves `asset:<name>` with. */
export function stageAssets(serveUrl: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, stage(serveUrl, file)]));
}

/** PNG stills of the edit at the given seconds, rendered with one browser. Returns the files in order. */
export async function renderStills(props: EditProps, times: number[], outDir: string): Promise<string[]> {
  const serveUrl = await getBundle();
  const browserExecutable = headlessShellPath();
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "Edit", inputProps, browserExecutable, logLevel: "error" });
  const browser = await openBrowser("chrome", { browserExecutable, logLevel: "error" });
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const out: string[] = [];
    for (const [i, t] of times.entries()) {
      const frame = Math.min(composition.durationInFrames - 1, Math.max(0, Math.round(t * props.fps)));
      const file = path.join(outDir, `still-${String(i).padStart(2, "0")}.png`);
      await renderStill({ composition, serveUrl, inputProps, frame, output: file, imageFormat: "png", puppeteerInstance: browser, browserExecutable, logLevel: "error" });
      out.push(file);
    }
    return out;
  } finally {
    await browser.close({ silent: true });
  }
}

/** Stills side by side in rows of `cols`, each `w` px wide: one image the editor can look at. */
export async function contactSheet(stills: string[], out: string, cols = 3, w = 640): Promise<string> {
  const inputs = stills.flatMap((s) => ["-i", s]);
  const scaled = stills.map((_, i) => `[${i}:v]scale=${w}:-2,pad=${w + 8}:ih+8:4:4:color=white[s${i}]`).join(";");
  const layout = stills.map((_, i) => `${(i % cols) === 0 ? "0" : Array.from({ length: i % cols }, () => "w0").join("+")}_${Math.floor(i / cols) === 0 ? "0" : Array.from({ length: Math.floor(i / cols) }, () => "h0").join("+")}`).join("|");
  const filter = stills.length === 1 ? `[0:v]scale=${w}:-2[out]` : `${scaled};${stills.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${stills.length}:layout=${layout}:fill=white[out]`;
  await run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", out]);
  return out;
}

export interface VideoOutput {
  file: MediaFile;
  probe: VideoProbe;
  issues: string[];
  frames: string[];
  notes: string[];
  ms: number;
}

/** Render the edit to `outPath`: H.264 + AAC, remuxed with faststart, probed, checked and sampled for previews. */
export async function renderEdit(props: EditProps, outPath: string): Promise<VideoOutput> {
  const t0 = Date.now();
  const serveUrl = await getBundle();
  const browserExecutable = headlessShellPath();
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "Edit", inputProps, browserExecutable, logLevel: "error" });
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
    inputProps,
    outputLocation: raw,
    overwrite: true,
    browserExecutable,
    logLevel: "error",
  });
  // Uniform container: H.264 copied, AAC stereo 48 kHz, moov atom first.
  await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", outPath]);
  fs.rmSync(raw, { force: true });

  const probe = await probeVideo(outPath);
  const issues = checkVideo(probe, { width: props.width, height: props.height });
  const frames = await extractFrames(outPath, probe.duration, path.join(path.dirname(outPath), "frames"));
  const ms = Date.now() - t0;
  return {
    file: { path: path.resolve(outPath), mime: "video/mp4", width: probe.width, height: probe.height, bytes: probe.bytes, duration_s: Math.round(probe.duration * 100) / 100 },
    probe,
    issues,
    frames,
    notes: [`edit ${probe.width}x${probe.height} ${probe.duration.toFixed(1)}s rendered in ${(ms / 1000).toFixed(1)}s`],
    ms,
  };
}

/** Source video duration and size via ffprobe. */
export async function probeSource(file: string): Promise<{ duration: number; width: number; height: number }> {
  const p = await probeVideo(file);
  return { duration: p.duration, width: p.width, height: p.height };
}
