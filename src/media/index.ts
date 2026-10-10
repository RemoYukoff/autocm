// Stream B (media). Signatures frozen at contracts-v1.
import fs from "node:fs";
import path from "node:path";
import { capabilitiesFor, loadProduct, productPath } from "../core/config.ts";
import { env } from "../core/env.ts";
import { FIXTURES_DIR, OUT_DIR, ROOT } from "../core/paths.ts";
import { Brief, Draft, type Capabilities, type MediaCopy, type MediaKind, type MediaResult, type Product, type TemplateId } from "../core/types.ts";
import { resolveBrand } from "./brand.ts";
import { mediaCopyOf } from "./copy.ts";
import { renderTemplate } from "./image.ts";
import { backgroundPrompt, pickImageProvider } from "./providers/image/index.ts";
import { falVideo } from "./providers/video/fal.ts";
import { renderClipCaption, renderKinetic, type VideoOutput } from "./video.ts";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

async function templateMedia(templateId: TemplateId, copy: MediaCopy, brief: Brief, product: Product, outDir: string, extra: { background?: string } = {}): Promise<MediaResult> {
  const notes: string[] = [];
  let id = templateId;
  let screen: string | undefined;
  if (id === "screenshot") {
    const s = product.config.assets.screens.find((x) => x.id === brief.screen_id) ?? (brief.screen_id ? undefined : product.config.assets.screens[0]);
    const file = s ? productPath(product, s.path) : undefined;
    if (file && fs.existsSync(file)) screen = file;
    else {
      notes.push(`screen "${brief.screen_id ?? "(none)"}" not found; rendered statement template instead`);
      id = "statement";
    }
  }
  const t0 = Date.now();
  const out = await renderTemplate({ templateId: id, copy, product, screen, background: extra.background }, path.join(outDir, "image.png"));
  notes.push(...out.notes.filter((n) => !n.startsWith("no ")), `template:${id} ${out.file.width}x${out.file.height} rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { kind: "template", files: [out.file], preview_frames: [out.file.path], notes };
}

function videoResult(kind: MediaKind, out: VideoOutput): MediaResult {
  return { kind, files: [out.file], preview_frames: out.frames, notes: [...out.notes, ...out.issues.map((i) => `qa: ${i}`)] };
}

const kinetic = async (copy: MediaCopy, product: Product, outDir: string) => videoResult("remotion", await renderKinetic(copy, product, path.join(outDir, "video.mp4")));

function fallback(r: MediaResult, from: MediaKind, why: string): MediaResult {
  return { ...r, fallback_from: from, notes: [`${from} failed, fell back to ${r.kind}: ${why}`, ...r.notes] };
}

/**
 * Produce the media for a post into `outDir`. For brief.media_kind "none" returns no files.
 * Must fall back (ai_image -> template, ai_video -> remotion) instead of throwing when a provider fails,
 * and set `fallback_from`. `preview_frames` must hold PNGs for visual QA (the image itself, or ~5 video frames).
 */
export async function produceMedia(brief: Brief, draft: Draft, product: Product, caps: Capabilities, outDir: string): Promise<MediaResult> {
  if (brief.media_kind === "none") return { kind: "none", files: [], preview_frames: [], notes: [] };
  fs.mkdirSync(outDir, { recursive: true });
  const copy = mediaCopyOf(draft);

  switch (brief.media_kind) {
    case "template":
      return templateMedia(brief.template_id ?? "statement", copy, brief, product, outDir);

    case "ai_image": {
      const provider = caps.ai_image ? pickImageProvider() : null;
      if (!provider) return fallback(await templateMedia("statement", copy, brief, product, outDir), "ai_image", "no image provider key");
      try {
        const brand = resolveBrand(product);
        const t0 = Date.now();
        const img = await provider.generate({ prompt: backgroundPrompt(brief.visual_direction ?? brief.angle, brand.colors), aspect: "16:9" });
        const ext = img.mime.includes("jpeg") ? ".jpg" : img.mime.includes("webp") ? ".webp" : ".png";
        const bg = path.join(outDir, `ai-background${ext}`);
        fs.writeFileSync(bg, img.bytes);
        const r = await templateMedia("statement", copy, brief, product, outDir, { background: bg });
        return { ...r, kind: "ai_image", notes: [`ai background by ${img.provider}/${img.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, ...r.notes] };
      } catch (e) {
        return fallback(await templateMedia("statement", copy, brief, product, outDir), "ai_image", `${provider.name}: ${errMsg(e)}`);
      }
    }

    case "remotion":
      return kinetic(copy, product, outDir);

    case "clip": {
      const clip = product.config.assets.clips.find((c) => c.id === brief.clip_id);
      const file = clip ? productPath(product, clip.path) : null;
      if (!caps.clip || !clip || !file || !fs.existsSync(file))
        return fallback(await kinetic(copy, product, outDir), "clip", clip ? `clip file missing: ${clip.path}` : `no clip "${brief.clip_id ?? ""}" in product`);
      try {
        return videoResult("clip", await renderClipCaption(file, copy, product, path.join(outDir, "video.mp4"), { start: clip.start, end: clip.end }));
      } catch (e) {
        return fallback(await kinetic(copy, product, outDir), "clip", errMsg(e));
      }
    }

    case "ai_video": {
      if (!caps.ai_video || !env.falKey) return fallback(await kinetic(copy, product, outDir), "ai_video", "ai_video disabled or no FAL_KEY");
      try {
        const brand = resolveBrand(product);
        const { bytes, model } = await falVideo(env.falKey, { prompt: backgroundPrompt(brief.visual_direction ?? brief.angle, brand.colors), aspect: "16:9" });
        const src = path.join(outDir, "ai-source.mp4");
        fs.writeFileSync(src, bytes);
        // The generated clip gets the same caption panel and end card as product clips.
        const r = videoResult("ai_video", await renderClipCaption(src, copy, product, path.join(outDir, "video.mp4")));
        return { ...r, notes: [`ai video by fal/${model}`, ...r.notes] };
      } catch (e) {
        return fallback(await kinetic(copy, product, outDir), "ai_video", errMsg(e));
      }
    }
  }
}

/** CLI `render-fixture`: render fixtures/<file> ({brief, draft}) for a product, print the result. */
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
