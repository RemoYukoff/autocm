// Technical QA for rendered video (ffprobe), modeled on 4foodies remotion/scripts/qa.mjs.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** X (Twitter) upload limits for video. */
export const X_VIDEO_LIMITS = { maxDuration: 140, minDuration: 0.5, maxBytes: 512 * 1024 * 1024, maxWidth: 1920, maxHeight: 1920 };

export interface VideoProbe {
  width: number;
  height: number;
  vcodec: string;
  pixFmt: string;
  fps: number;
  acodec: string | null;
  duration: number;
  bytes: number;
  /** moov atom before mdat (fast start). null when unknown. */
  faststart: boolean | null;
}

interface FfprobeJson {
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string }[];
  format?: { duration?: string; size?: string };
}

const rate = (r?: string) => {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  return d ? (n ?? 0) / d : (n ?? 0);
};

/** Pure: ffprobe -of json output -> VideoProbe. */
export function parseProbe(json: FfprobeJson | string, bytes?: number): VideoProbe {
  const j: FfprobeJson = typeof json === "string" ? JSON.parse(json) : json;
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    vcodec: v?.codec_name ?? "none",
    pixFmt: v?.pix_fmt ?? "unknown",
    fps: Math.round(rate(v?.r_frame_rate) * 100) / 100,
    acodec: a?.codec_name ?? null,
    duration: Number(j.format?.duration ?? 0),
    bytes: bytes ?? Number(j.format?.size ?? 0),
    faststart: null,
  };
}

/**
 * True when the first top-level `moov` box comes before `mdat` (fast start). Walks box headers through
 * `read(offset, length)` so a large mdat is never loaded; null when neither box is found.
 */
export function moovBeforeMdat(read: (offset: number, length: number) => Buffer): boolean | null {
  let off = 0;
  for (let i = 0; i < 64; i++) {
    const hdr = read(off, 16);
    if (hdr.length < 8) return null;
    let size = hdr.readUInt32BE(0);
    const type = hdr.toString("ascii", 4, 8);
    if (type === "moov") return true;
    if (type === "mdat") return false;
    if (size === 1 && hdr.length >= 16) size = Number(hdr.readBigUInt64BE(8));
    if (size < 8) return null;
    off += size;
  }
  return null;
}

export async function probeVideo(file: string): Promise<VideoProbe> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate",
    "-of", "json",
    file,
  ]);
  const probe = parseProbe(stdout, fs.statSync(file).size);
  const fd = fs.openSync(file, "r");
  try {
    probe.faststart = moovBeforeMdat((off, len) => {
      const buf = Buffer.alloc(len);
      return buf.subarray(0, fs.readSync(fd, buf, 0, len, off));
    });
  } finally {
    fs.closeSync(fd);
  }
  return probe;
}

export interface VideoExpect {
  width?: number;
  height?: number;
  minDuration?: number;
  maxDuration?: number;
  maxBytes?: number;
  requireAudio?: boolean;
}

/** Pure: list of problems that would make X reject the file or look wrong. Empty = pass. */
export function checkVideo(p: VideoProbe, e: VideoExpect = {}): string[] {
  const issues: string[] = [];
  const maxDur = e.maxDuration ?? X_VIDEO_LIMITS.maxDuration;
  const minDur = e.minDuration ?? X_VIDEO_LIMITS.minDuration;
  const maxBytes = e.maxBytes ?? X_VIDEO_LIMITS.maxBytes;
  if (p.vcodec !== "h264") issues.push(`video codec ${p.vcodec} (expected h264)`);
  if (p.pixFmt !== "yuv420p") issues.push(`pixel format ${p.pixFmt} (expected yuv420p)`);
  if ((e.requireAudio ?? true) && !p.acodec) issues.push("no audio track");
  if (p.acodec && p.acodec !== "aac") issues.push(`audio codec ${p.acodec} (expected aac)`);
  if (!(p.duration >= minDur)) issues.push(`duration ${p.duration.toFixed(2)}s below ${minDur}s`);
  if (p.duration > maxDur) issues.push(`duration ${p.duration.toFixed(2)}s above ${maxDur}s`);
  if (p.bytes > maxBytes) issues.push(`size ${(p.bytes / 1e6).toFixed(1)}MB above ${(maxBytes / 1e6).toFixed(0)}MB`);
  if (p.width % 2 || p.height % 2) issues.push(`odd dimensions ${p.width}x${p.height}`);
  if (p.width > X_VIDEO_LIMITS.maxWidth || p.height > X_VIDEO_LIMITS.maxHeight) issues.push(`resolution ${p.width}x${p.height} above 1920`);
  if (e.width && e.height && (p.width !== e.width || p.height !== e.height))
    issues.push(`resolution ${p.width}x${p.height} (expected ${e.width}x${e.height})`);
  if (p.fps > 60) issues.push(`frame rate ${p.fps} above 60`);
  if (p.faststart === false) issues.push("moov atom after mdat (not faststart)");
  return issues;
}
