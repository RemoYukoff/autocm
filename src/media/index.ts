// Media stage: designed images, kinetic videos and captioned product clips.
import fs from "node:fs";
import path from "node:path";
import { designImage } from "../agents/designer.ts";
import { capabilitiesFor, loadProduct, productPath } from "../core/config.ts";
import { FIXTURES_DIR, OUT_DIR, ROOT } from "../core/paths.ts";
import { Brief, Draft, type Capabilities, type MediaKind, type MediaResult, type Product, type VideoCopy } from "../core/types.ts";
import { renderClipCaption, renderKinetic, type VideoOutput } from "./video.ts";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

function videoResult(kind: MediaKind, out: VideoOutput): MediaResult {
  return { kind, files: [out.file], preview_frames: out.frames, notes: [...out.notes, ...out.issues.map((i) => `qa: ${i}`)] };
}

/** The draft's video copy, or the tweet's first sentence as a one-beat headline. */
function videoCopyOf(draft: Draft): VideoCopy {
  if (draft.video?.headline.trim() || draft.video?.beats.some((b) => b.trim())) return draft.video;
  const first = draft.text.split(/(?<=[.!?])\s+|\n+/)[0]?.trim() ?? draft.text.trim();
  return { headline: first.length > 110 ? `${first.slice(0, 107).replace(/\s+\S*$/, "")}…` : first, beats: [], highlight_words: [] };
}

const kinetic = async (copy: VideoCopy, product: Product, outDir: string) => videoResult("kinetic", await renderKinetic(copy, product, path.join(outDir, "video.mp4")));

/**
 * Produce the media for a post into `outDir`. For brief.media_kind "none" returns no files.
 * A clip that cannot be used falls back to a kinetic video and sets `fallback_from`; a design that fails throws.
 * `preview_frames` holds PNGs for the dashboard preview (the image itself, or ~5 video frames).
 */
export async function produceMedia(brief: Brief, draft: Draft, product: Product, caps: Capabilities, outDir: string, postId?: number): Promise<MediaResult> {
  if (brief.media_kind === "none") return { kind: "none", files: [], preview_frames: [], notes: [] };
  fs.mkdirSync(outDir, { recursive: true });

  switch (brief.media_kind) {
    case "design": {
      if (!brief.visual) throw new Error("design post without a visual concept");
      const out = await designImage({ product, brief: { ...brief, visual: brief.visual }, text: draft.text, outDir, postId });
      return { kind: "design", files: [out.file], preview_frames: [out.file.path], alt_text: out.alt_text, notes: out.notes };
    }

    case "kinetic":
      return kinetic(videoCopyOf(draft), product, outDir);

    case "clip": {
      const copy = videoCopyOf(draft);
      const clip = product.config.assets.clips.find((c) => c.id === brief.clip_id);
      const file = clip ? productPath(product, clip.path) : null;
      const fallback = async (why: string): Promise<MediaResult> => {
        const r = await kinetic(copy, product, outDir);
        return { ...r, fallback_from: "clip", notes: [`clip failed, fell back to kinetic: ${why}`, ...r.notes] };
      };
      if (!caps.clip || !clip || !file || !fs.existsSync(file)) return fallback(clip ? `clip file missing: ${clip.path}` : `no clip "${brief.clip_id ?? ""}" in product`);
      try {
        return videoResult("clip", await renderClipCaption(file, copy, product, path.join(outDir, "video.mp4"), { start: clip.start, end: clip.end }));
      } catch (e) {
        return fallback(errMsg(e));
      }
    }
  }
}

/** CLI `render-fixture`: render fixtures/<file> ({brief, draft}) for a product, print the result. Design fixtures call the designer agent. */
export async function renderFixture(fixturePath: string, productSlug: string): Promise<MediaResult> {
  const candidates = [fixturePath, path.resolve(ROOT, fixturePath), path.join(FIXTURES_DIR, fixturePath), path.join(FIXTURES_DIR, "media", fixturePath)];
  const file = candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) throw new Error(`fixture not found: ${fixturePath}`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { brief?: unknown; draft?: unknown };
  const brief = Brief.parse(raw.brief);
  const draft = Draft.parse(raw.draft);
  const product = loadProduct(productSlug);
  const outDir = path.join(OUT_DIR, "fixtures", path.basename(file, ".json"));
  fs.rmSync(outDir, { recursive: true, force: true });
  return produceMedia(brief, draft, product, capabilitiesFor(product), outDir);
}
