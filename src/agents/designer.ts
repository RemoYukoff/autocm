// Designer: turns the marketer's visual concept into a finished image. It writes HTML/CSS/SVG from scratch in the
// brand's style, renders it with the `render` tool, looks at the result and fixes it, then names the render to publish.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright-core";
import { z } from "zod";
import { productPath } from "../core/config.ts";
import { recentPosts } from "../core/db/index.ts";
import { log } from "../core/log.ts";
import type { Brief, MediaFile, MediaResult, Product, Visual } from "../core/types.ts";
import { callJson, toolImage, toolText } from "../llm.ts";
import { launchBrowser } from "../media/browser.ts";
import { designKit, IMAGE_SIZES, minFontPx, renderDesign } from "../media/design.ts";
import { generationTools, IMAGE_MODELS, type AssetBag } from "./assets.ts";

/** Renders the designer may ask for; the last ones are for polish, so a few is plenty. */
const MAX_RENDERS = 6;
/** ElevenLabs pictures per design session (each costs credits and about a minute). */
const MAX_IMAGES = 2;

export interface DesignInput {
  product: Product;
  brief: Brief & { visual: Visual };
  /** The tweet the image goes under. */
  text: string;
  outDir: string;
  postId?: number;
}

export interface DesignOutput {
  file: MediaFile;
  alt_text: string;
  /** Renders made, final choice and any problems left on it. */
  notes: string[];
}

/** The product's last designed images (newest first), so a new one does not repeat their composition. */
function recentDesigns(product: Product, n = 3): string[] {
  const out: string[] = [];
  for (const p of recentPosts(product.config.slug, 20)) {
    if (p.media_kind !== "design" || !p.media_json) continue;
    const file = (JSON.parse(p.media_json) as MediaResult).files[0]?.path;
    if (file && fs.existsSync(file)) out.push(file);
    if (out.length === n) break;
  }
  return out;
}

const Answer = z.object({
  render: z.number().int().describe("Number of the render to publish (usually the last, clean one)"),
  alt_text: z.string().describe("Image description for screen readers: what it shows and every word on it, max 400 chars"),
});

function prompt(input: DesignInput, hasReference: boolean, recent: number): string {
  const { product, brief, text } = input;
  const c = product.config;
  const v = brief.visual;
  const { w, h } = IMAGE_SIZES[v.aspect];
  const kit = designKit(product);
  return `You are the senior brand designer for ${c.name} (${c.url}). The marketing lead wrote a concept for the image of
the next X (Twitter) post; you design that image from scratch, as a self-contained HTML page that is screenshotted at
${w}x${h} px. You own the composition, typography, color, illustration and every pixel. Make it look like a top
design studio made it for this brand, not like a template.

${hasReference ? `# Visual reference\nThe first attached image is the product's website: match its look and feel (type, color, spacing, mood), do not copy its layout.\n` : ""}${recent ? `# Your last images\nThe ${hasReference ? "other" : ""} attached image(s) are the account's last ${recent} designed post(s), newest first. They appear in the same feed: stay on-brand but make this one clearly different in composition, layout, scale and focal element (and aspect if the concept allows), so the account never looks like it runs on a template.\n` : ""}
# Brand manual
${c.brand.guidelines.map((g) => `- ${g}`).join("\n")}

Brand variables already defined in /brand.css (loaded before your styles):
${Object.entries(kit.vars).map(([k, val]) => `- ${k}: ${val}`).join("\n")}
Loaded font families: ${kit.families.join(", ")} (use var(--font-sans) / var(--font-mono); no other fonts exist).
Logos: ${kit.logos.map((l) => `${l.url} (${l.use})`).join(", ") || "(none)"}
${kit.screens.length ? `Product screenshots you may place (img src):\n${kit.screens.map((s) => `- ${s.url}: ${s.description}`).join("\n")}` : "No product screenshots are available: do not draw the product's own UI."}

# The post
Goal: ${brief.goal}. Play: ${brief.play}. Angle: ${brief.angle}
Tweet text shown above the image (the image must add to it, not repeat it):
"""
${text}
"""

# The concept (from the marketing lead)
${v.concept}

Words that must be on the image: ${v.words}
Canvas: ${w}x${h} px (${v.aspect}).

# Facts
Every word on the image must be true. Extra microcopy (labels, chat lines, ticket fields) may only use facts from the
knowledge base below. No invented numbers, customers, quotes or features. Do not imitate real third-party brands'
logos or interfaces (a generic chat, ticket or code window is fine).

<knowledge>
${product.knowledge}
</knowledge>

# What makes a feed image work
- It is seen on a phone at about a third of its size, between other posts, for under two seconds. One focal point,
  one idea, a clear reading order. Text at least ${minFontPx(w)} px; the main line much bigger.
- Concrete beats abstract: build the thing the concept talks about (a ticket, a diff, a chat, a sticky note, a
  checklist, a chart, a before/after, an object) rather than a title on a gradient. Specific details sell it.
- Typographic hierarchy with real contrast in size and weight; tight tracking on big display type; few words.
- Strong contrast (text at least 4.5:1 on its background). Generous margins: keep text 6% or more from the edges.
- The brand is present but quiet: small logo or ${new URL(c.url).hostname.replace(/^www\./, "")} in a corner. No calls to action on the image.
- Avoid the generic AI look: no random glowing blobs, no purple gradient soup, no centered title with a subtitle
  and nothing else, no emoji, no clip-art icons.

# Generated images (ElevenLabs)
You can call generate_image (up to ${MAX_IMAGES} times, about a minute each) for a photo, an illustration, an object or a
texture that HTML/CSS/SVG can't draw well, then place it in your page like any image. You see the result before
using it. Use it when a real picture makes the concept land (a scene, a physical object, a mood); skip it when type,
shapes and a drawn artifact carry the idea, which is often. Your HTML still owns all brand text, the logo and the layout.
Reference a generated picture as <img src="asset:gen-1.png"> (the name the tool returns).
Prompts for it: describe the picture concretely (subject, framing, light, background, palette in the brand's colors),
leave calm space where your text will sit, and never ask for real brands, logos, product UIs, celebrities or
readable text (unless you chose the text model on purpose for that). Models: ${Object.entries(IMAGE_MODELS).map(([m, d]) => `${m} (${d})`).join("; ")}.

# How to work
1. Write the full HTML page (inline <style>; inline SVG for any illustration). The page body is the canvas, fixed at
   ${w}x${h}; only the URLs above load (no web fonts, no external images, no scripts needed).
2. Call render with it. You get the screenshot plus a list of layout problems found (text clipped, off the canvas,
   too small, overlapping, missing fonts).
3. Look at the screenshot critically, as the art director would: fix every listed problem and anything that looks
   off (alignment, spacing, hierarchy, balance, contrast, the joke not landing). Render again.
4. You have up to ${MAX_RENDERS} renders. Stop when it is clean and you would sign it. Then answer with the number of the
   render to publish and its alt text.`;
}

/** Design, render and pick the image for a post. A failed session starts over once. */
export async function designImage(input: DesignInput): Promise<DesignOutput> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await designOnce(input, path.join(input.outDir, "design", `try-${attempt}`));
    } catch (e) {
      if (attempt >= 2) throw e;
      log.warn({ post: input.postId, err: (e as Error).message.slice(0, 300) }, "design failed, starting over");
    }
  }
}

async function designOnce(input: DesignInput, work: string): Promise<DesignOutput> {
  const { product, brief, outDir } = input;
  const aspect = brief.visual.aspect;
  fs.mkdirSync(work, { recursive: true });
  const reference = productPath(product, product.config.brand.reference);
  const hasReference = fs.existsSync(reference);
  const recent = recentDesigns(product);
  const images = [...(hasReference ? [reference] : []), ...recent];

  let browser: Browser | null = null;
  const renders: { file: MediaFile; problems: string[]; html: string }[] = [];
  const bag: AssetBag = { dir: work, files: {}, postId: input.postId };
  const render = tool(
    "render",
    `Render a full HTML page at the canvas size and return the screenshot plus layout problems. Up to ${MAX_RENDERS} calls.`,
    { html: z.string().describe("The complete HTML document") },
    async ({ html }) => {
      if (renders.length >= MAX_RENDERS) return toolText(`Render limit (${MAX_RENDERS}) reached. Answer now with the render to publish.`);
      const n = renders.length + 1;
      const base = path.join(work, `render-${n}`);
      fs.writeFileSync(`${base}.html`, html);
      try {
        browser ??= await launchBrowser();
        const out = await renderDesign(html, product, aspect, `${base}.png`, { browser, assets: bag.files });
        renders.push({ ...out, html });
        const report = out.problems.length ? `Problems found:\n${out.problems.map((p) => `- ${p}`).join("\n")}` : "No layout problems found.";
        return toolImage(out.file.path, `Render #${n} (${out.file.width}x${out.file.height}). ${report}\n${MAX_RENDERS - n} render(s) left.`);
      } catch (e) {
        return toolText(`Render #${n} failed: ${(e as Error).message.split("\n")[0]}. Fix the HTML and render again.`);
      }
    },
  );

  try {
    const answer = await callJson(Answer, prompt(input, hasReference, recent.length), {
      stage: "designer",
      model: "opus",
      postId: input.postId,
      images,
      tools: [render, ...generationTools(bag, { images: MAX_IMAGES, clips: 0, music: 0 })],
      maxTurns: (MAX_RENDERS + MAX_IMAGES) * 2 + 4,
      timeoutMs: 30 * 60_000,
      attempts: 1,
      system:
        "You are a senior brand designer working inside an automated content pipeline. You design with HTML, CSS and SVG, " +
        "check your work with the render tool, and answer only through the structured output.",
    });
    const pick = renders[answer.render - 1] ?? renders[renders.length - 1];
    if (!pick) throw new Error("the designer produced no render");
    const file = path.join(outDir, "image.png");
    fs.copyFileSync(pick.file.path, file);
    fs.writeFileSync(path.join(outDir, "design.html"), pick.html);
    for (const [name, src] of Object.entries(bag.files)) if (pick.html.includes(`asset:${name}`)) fs.copyFileSync(src, path.join(outDir, name));
    const chosen = renders.indexOf(pick) + 1;
    return {
      file: { ...pick.file, path: path.resolve(file) },
      alt_text: answer.alt_text.slice(0, 1000),
      notes: [`design: ${renders.length} render(s), ${Object.keys(bag.files).length} ElevenLabs image(s), published #${chosen} at ${pick.file.width}x${pick.file.height}`, ...pick.problems.map((p) => `design problem left: ${p}`)],
    };
  } finally {
    await (browser as Browser | null)?.close();
  }
}
