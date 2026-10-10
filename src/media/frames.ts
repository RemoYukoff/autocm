// Preview frames for the dashboard: PNG stills at fixed fractions of the video.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const PREVIEW_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];

/** Timestamps (s) for the given fractions, kept a frame away from the end so ffmpeg always finds one. */
export function frameTimes(duration: number, points = PREVIEW_POINTS, fps = 30): number[] {
  const last = Math.max(0, duration - 1 / fps);
  return points.map((p) => Math.round(Math.min(last, Math.max(0, duration * p)) * 1000) / 1000);
}

export async function extractFrames(video: string, duration: number, outDir: string, points = PREVIEW_POINTS): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const times = frameTimes(duration, points);
  return Promise.all(
    times.map(async (t, i) => {
      const out = path.join(outDir, `frame-${String(Math.round((points[i] ?? 0) * 100)).padStart(2, "0")}.png`);
      await run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", video, "-frames:v", "1", "-update", "1", out]);
      return out;
    }),
  );
}
