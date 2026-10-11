// Editor: turns the marketer's video concept into a finished video. It gathers footage, pictures and music on
// ElevenLabs (src/agents/assets.ts), cuts them together with animated HTML/CSS scenes in the brand's style as a
// timeline (src/media/edit.ts), checks previews (stills plus layout problems) and fixes them, then names the
// preview to publish; Remotion renders it.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright-core";
import { z } from "zod";
import { productPath } from "../core/config.ts";
import { log } from "../core/log.ts";
import type { Brief, MediaResult, Product, Visual } from "../core/types.ts";
import { callJson, toolImage, toolText } from "../llm.ts";
import { launchBrowser } from "../media/browser.ts";
import { designKit, minFontPx, renderDesign } from "../media/design.ts";
import { brandFiles, editProps, MAX_SECONDS, MIN_SECONDS, previewTimes, Timeline, timelineProblems, VIDEO_CANVAS } from "../media/edit.ts";
import { contactSheet, renderEdit, renderStills } from "../media/video.ts";
import { generationTools, IMAGE_MODELS, type AssetBag } from "./assets.ts";

const MAX_PREVIEWS = 6;
const LIMITS = { images: 4, clips: 2, music: 1 };

export interface EditInput {
  product: Product;
  brief: Brief & { visual: Visual };
  /** The tweet the video goes under. */
  text: string;
  outDir: string;
  postId?: number;
}

const Answer = z.object({
  preview: z.number().int().describe("Number of the preview to publish (usually the last, clean one)"),
  alt_text: z.string().describe("What the video shows and says, for screen readers, max 400 chars"),
});

/** Every file the edit can use, named as the editor references it. */
function startingFiles(product: Product, dir: string): { files: Record<string, string>; listing: string[] } {
  const files = brandFiles(product, path.join(dir, "brand"));
  const listing = Object.keys(files).map((n) => `- ${n}: the brand logo, for a ${n.includes("dark") ? "dark" : "light"} background`);
  for (const c of product.config.assets.clips) {
    const file = productPath(product, c.path);
    if (!fs.existsSync(file)) continue;
    const name = `product-${c.id}${path.extname(file)}`;
    files[name] = file;
    listing.push(`- ${name} (video): real product footage. ${c.description}`);
  }
  for (const s of product.config.assets.screens) {
    const file = productPath(product, s.path);
    if (!fs.existsSync(file)) continue;
    const name = `screen-${s.id}${path.extname(file)}`;
    files[name] = file;
    listing.push(`- ${name} (image): product screenshot. ${s.description}`);
  }
  return { files, listing };
}

function prompt(input: EditInput, hasReference: boolean, listing: string[]): string {
  const { product, brief, text } = input;
  const c = product.config;
  const v = brief.visual;
  const kit = designKit(product);
  const canvases = Object.entries(VIDEO_CANVAS).map(([k, s]) => `${k} ${s.w}x${s.h}`).join(", ");
  return `You are the senior motion designer and video editor for ${c.name} (${c.url}). The marketing lead wrote a
concept for the video of the next X (Twitter) post; you make that video from scratch. You decide the story beats,
the footage and pictures you need (you can generate them), the animated type and graphics, the music, the cut and
the timing. Make it look like a top studio made it for this brand, not like a template.

${hasReference ? "# Visual reference\nThe attached image is the product's website: match its look and feel, do not copy its layout.\n" : ""}
# Brand manual
${c.brand.guidelines.map((g) => `- ${g}`).join("\n")}

Brand variables available in your CSS: ${Object.entries(kit.vars).map(([k, val]) => `${k} (${val})`).join(", ")}.
Loaded fonts: ${kit.families.join(", ")} (use var(--font-sans) / var(--font-mono); no other fonts exist).

# The post
Goal: ${brief.goal}. Play: ${brief.play}. Angle: ${brief.angle}
Tweet text shown above the video (the video must add to it, not read it out):
"""
${text}
"""

# The concept (from the marketing lead)
${v.concept}
${v.words ? `Words it should carry: ${v.words}` : ""}
Suggested canvas: ${v.aspect} (${canvases}; portrait and square fill more of a phone).

# Facts
Every word on screen must be true. Extra microcopy may only use facts from the knowledge base below. No invented
numbers, customers, quotes or features; never show the product's own UI except through the product files listed.
No real third-party brands, logos or people.

<knowledge>
${product.knowledge}
</knowledge>

# What works for video on X
- It autoplays muted in the feed: the story must read with the sound off. Words on screen carry it; sound is a bonus.
- The first second decides everything: something meaningful is on screen at 0.0 s (no fade from black, no empty intro).
- One idea, ${MIN_SECONDS}-${MAX_SECONDS} s (usually 8-20), about 2-3 s per beat, a clear payoff, then the brand (logo and
  ${new URL(c.url).hostname.replace(/^www\./, "")}) for the last 1.5-2 s. No calls to action on screen.
- Big type: at least ${minFontPx(1080)} px on a 1080-wide canvas, generous margins (6%+), strong contrast over footage.
- Motion with intent: quick, eased entrances; nothing drifting for its own sake. Cuts on the beat of the story.

# Files you can use
${listing.join("\n")}
Plus what you generate:
- generate_clip: real-looking footage (Veo 3.1 Fast, 4/6/8 s, 16:9 or 9:16, with sound; about $1.30 each, up to ${LIMITS.clips}).
  Use it when live action makes the concept land (a physical scene, a gesture, a place). It cannot show readable
  text or UI; your HTML scenes carry the words. Footage is cropped to your canvas with fit "cover".
- generate_image: a picture (up to ${LIMITS.images}; models: ${Object.entries(IMAGE_MODELS).map(([m, d]) => `${m}: ${d}`).join("; ")}).
- generate_music: one instrumental bed (up to ${LIMITS.music}). Keep it under the footage's own sound (volume 0.3-0.5 when
  the footage has sound, 0.6-0.8 when it does not).

# The timeline you write
{ canvas, duration (s), css, layers: [...] } — layers draw bottom to top, each with start and duration in seconds:
- html: a full-canvas scene (the layer root is position:absolute; inset:0). Write the markup; all styles go in the
  one shared css. Animate with CSS @keyframes and animation-delay for staggering: every animation is frozen to the
  layer's own clock (time 0 = the layer's start), so they always render exactly. --t (seconds) and --p (0..1) on
  the layer root hold its time for calc()-driven motion. Transparent backgrounds let lower layers show through.
  Images: <img src="asset:<name>">.
- video: { src: "<file name>", trim, box {x,y,width,height,radius} (default full canvas), fit, volume, fadeIn, fadeOut, zoom [start,end] }.
- audio: { src, trim, volume, fadeIn, fadeOut }.

# How to work
1. Plan the beats. Generate the footage, pictures and music you need (they take minutes; ask for all you need up front).
2. Write the timeline and call preview: you get stills across it (left to right, top to bottom, with their times)
   and the layout problems found in each html scene (text clipped, off the canvas, too small, overlapping, missing fonts).
3. Look at the stills as the creative director would: fix every listed problem and anything that looks off (hierarchy,
   timing, readability over footage, the joke not landing). Preview again. Up to ${MAX_PREVIEWS} previews.
4. Answer with the number of the preview to publish and its alt text.`;
}

/** Make, preview and render the video for a post. Throws when no usable preview was produced. */
export async function editVideo(input: EditInput): Promise<MediaResult> {
  const { product, outDir } = input;
  const work = path.join(outDir, "edit");
  fs.mkdirSync(work, { recursive: true });
  const reference = productPath(product, product.config.brand.reference);
  const hasReference = fs.existsSync(reference);
  const { files, listing } = startingFiles(product, work);
  const bag: AssetBag = { dir: work, files, postId: input.postId };

  let browser: Browser | null = null;
  const previews: { timeline: Timeline; problems: string[] }[] = [];
  const preview = tool(
    "preview",
    `Check a timeline: returns stills across it and the layout problems found. Up to ${MAX_PREVIEWS} calls.`,
    Timeline.shape,
    async (args) => {
      if (previews.length >= MAX_PREVIEWS) return toolText(`Preview limit (${MAX_PREVIEWS}) reached. Answer now with the preview to publish.`);
      const parsed = Timeline.safeParse(args);
      if (!parsed.success) return toolText(`The timeline is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const t = parsed.data;
      const n = previews.length + 1;
      const dir = path.join(work, `preview-${n}`);
      try {
        const problems = timelineProblems(t, bag.files);
        const { w, h } = VIDEO_CANVAS[t.canvas];
        const times = previewTimes(t);
        const stills = await renderStills(await editProps(t, product, bag.files), times, dir);
        const sheet = await contactSheet(stills, path.join(work, `preview-${n}.png`), t.canvas === "landscape" ? 3 : 4, t.canvas === "landscape" ? 560 : 360);
        browser ??= await launchBrowser();
        for (const [i, l] of t.layers.entries()) {
          if (l.kind !== "html") continue;
          const doc = `<style>.layer{position:absolute;inset:0;overflow:hidden;font-family:var(--font-sans)}\n${t.css}</style><div class="layer">${l.html}</div>`;
          const r = await renderDesign(doc, product, { w, h }, path.join(dir, `scene-${i}.png`), { browser, assets: bag.files, seek: l.duration * 0.6 });
          problems.push(...r.problems.filter((p) => !/words on the image/.test(p)).map((p) => `Scene ${i} (${l.start}-${l.start + l.duration}s): ${p}`));
        }
        previews.push({ timeline: t, problems });
        fs.writeFileSync(path.join(work, `preview-${n}.json`), JSON.stringify(t, null, 2));
        const report = problems.length ? `Problems found:\n${problems.map((p) => `- ${p}`).join("\n")}` : "No problems found.";
        return toolImage(sheet, `Preview #${n}: stills at ${times.map((x) => `${x}s`).join(", ")}. ${report}\n${MAX_PREVIEWS - n} preview(s) left.`);
      } catch (e) {
        return toolText(`Preview #${n} failed: ${(e as Error).message.split("\n")[0]}. Fix the timeline and try again.`);
      }
    },
  );

  try {
    const answer = await callJson(Answer, prompt(input, hasReference, listing), {
      stage: "editor",
      model: "opus",
      postId: input.postId,
      images: hasReference ? [reference] : [],
      tools: [preview, ...generationTools(bag, LIMITS)],
      maxTurns: (MAX_PREVIEWS + LIMITS.images + LIMITS.clips + LIMITS.music) * 2 + 6,
      timeoutMs: 60 * 60_000,
      attempts: 1,
      system:
        "You are a senior motion designer working inside an automated content pipeline. You build videos as timelines of " +
        "HTML/CSS scenes, footage and audio, check them with the preview tool, and answer only through the structured output.",
    });
    const pick = previews[answer.preview - 1] ?? previews[previews.length - 1];
    if (!pick) throw new Error("the editor produced no preview");
    fs.writeFileSync(path.join(outDir, "edit.json"), JSON.stringify(pick.timeline, null, 2));
    const out = await renderEdit(await editProps(pick.timeline, product, bag.files), path.join(outDir, "video.mp4"));
    const generated = Object.keys(bag.files).filter((n) => /^(gen|clip|music)-/.test(n));
    log.info({ post: input.postId, previews: previews.length, generated }, "video edited");
    return {
      kind: "video",
      files: [out.file],
      preview_frames: out.frames,
      alt_text: answer.alt_text.slice(0, 1000),
      notes: [
        `edit: ${previews.length} preview(s), published #${previews.indexOf(pick) + 1}; ElevenLabs: ${generated.join(", ") || "nothing"}`,
        ...out.notes,
        ...pick.problems.map((p) => `edit problem left: ${p}`),
        ...out.issues.map((i) => `qa: ${i}`),
      ],
    };
  } finally {
    await (browser as Browser | null)?.close();
  }
}
