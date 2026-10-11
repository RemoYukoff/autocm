// Media stage: an image the designer agent builds, or a video the editor agent cuts. Both use ElevenLabs for
// generated pictures, footage and music (src/agents/assets.ts).
import fs from "node:fs";
import path from "node:path";
import { designImage } from "../agents/designer.ts";
import { editVideo } from "../agents/editor.ts";
import { loadProduct } from "../core/config.ts";
import { FIXTURES_DIR, OUT_DIR, ROOT } from "../core/paths.ts";
import { Brief, Draft, type MediaResult, type Product } from "../core/types.ts";

/**
 * Produce the media for a post into `outDir`. For brief.media_kind "none" returns no files; a design or an edit that
 * fails throws. `preview_frames` holds PNGs for the dashboard preview (the image itself, or ~5 video frames).
 */
export async function produceMedia(brief: Brief, draft: Draft, product: Product, outDir: string, postId?: number): Promise<MediaResult> {
  if (brief.media_kind === "none") return { kind: "none", files: [], preview_frames: [], notes: [] };
  fs.mkdirSync(outDir, { recursive: true });
  if (!brief.visual) throw new Error(`${brief.media_kind} post without a visual concept`);
  const input = { product, brief: { ...brief, visual: brief.visual }, text: draft.text, outDir, postId };

  if (brief.media_kind === "design") {
    const out = await designImage(input);
    return { kind: "design", files: [out.file], preview_frames: [out.file.path], alt_text: out.alt_text, notes: out.notes };
  }
  return editVideo(input);
}

/** CLI `render-fixture`: make the media of fixtures/<file> ({brief, draft}) for a product (runs the designer or editor). */
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
  return produceMedia(brief, draft, product, outDir);
}
