// Generation tools the designer and the editor share: pictures, footage and music made on ElevenLabs
// (src/media/elevenlabs.ts), saved into the post's folder and referenced from HTML as `asset:<name>`.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { toolImage, toolText, type AgentTool } from "../llm.ts";
import { generate } from "../media/elevenlabs.ts";
import { pngSize } from "../media/files.ts";
import { probeVideo } from "../media/qa.ts";

const run = promisify(execFile);

/** ElevenLabs image models the agents may pick, and what each is for. */
export const IMAGE_MODELS = {
  "gpt-image-2.5-sunburst": "default: photos, illustrations, objects, scenes",
  "gpt-image-2": "when the picture itself must contain legible text, a UI mockup or a multi-panel layout",
  "bytedance-seedream-5-pro": "photorealism and product-shot looks",
  "recraft-v4.1": "flat vector illustration, icons and graphic shapes",
} as const;
type ImageModel = keyof typeof IMAGE_MODELS;
const IMAGE_ASPECTS = ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"] as const;

export const CLIP_MODEL = "veo-3.1-fast-generate-001";
export const MUSIC_MODEL = "eleven_music_v2_5";

export interface Limits {
  images: number;
  clips: number;
  music: number;
}

/** Files of one design/edit session: name -> path. Generated files are added as they arrive. */
export interface AssetBag {
  dir: string;
  files: Record<string, string>;
  postId?: number;
}

const PROMPT_RULES = "Never ask for real brands, logos, product UIs, celebrities or readable text (unless you chose a text model on purpose).";

export function generationTools(bag: AssetBag, limits: Limits): AgentTool[] {
  const used = { images: 0, clips: 0, music: 0 };
  const failed = (e: unknown) => toolText(`Generation failed: ${(e as Error).message.split("\n")[0]}. Carry on without it or try a different prompt.`);
  const tools: AgentTool[] = [];

  if (limits.images)
    tools.push(
      tool(
        "generate_image",
        `Generate one picture on ElevenLabs (about a minute) and get back its asset name. Up to ${limits.images} per post. ${PROMPT_RULES}`,
        {
          prompt: z.string().describe("What the picture shows: subject, framing, light, background, palette; leave calm space where text will sit"),
          aspect_ratio: z.enum(IMAGE_ASPECTS),
          model: z.enum(Object.keys(IMAGE_MODELS) as [ImageModel, ...ImageModel[]]),
        },
        async ({ prompt, aspect_ratio, model }) => {
          if (used.images >= limits.images) return toolText(`Image limit (${limits.images}) reached; use what you have.`);
          const n = ++used.images;
          try {
            const out = await generate({ kind: "image", model, prompt, params: { aspect_ratio, resolution: "2K", quality: "high" }, out: path.join(bag.dir, `gen-${n}`), postId: bag.postId });
            const name = path.basename(out.file);
            bag.files[name] = out.file;
            const size = out.file.endsWith(".png") ? pngSize(out.file) : null;
            return toolImage(out.file, `Generated ${name}${size ? ` (${size.width}x${size.height})` : ""}. Use it as asset:${name}.`);
          } catch (e) {
            return failed(e);
          }
        },
      ),
    );

  if (limits.clips)
    tools.push(
      tool(
        "generate_clip",
        `Generate one video clip on ElevenLabs with Google Veo 3.1 Fast (about 2-4 minutes, with sound, 1080p, 16:9 or 9:16 only). Expensive: up to ${limits.clips} per post, only when real footage carries the idea. ${PROMPT_RULES}`,
        {
          prompt: z.string().describe("What happens second by second, camera (framing, movement), light, look, and sound (ambience, foley; no music)"),
          negative_prompt: z.string().describe("What must not appear (text, captions, logos, watermarks, distorted hands...)"),
          duration_secs: z.union([z.literal(4), z.literal(6), z.literal(8)]),
          aspect_ratio: z.enum(["16:9", "9:16"]),
        },
        async ({ prompt, negative_prompt, duration_secs, aspect_ratio }) => {
          if (used.clips >= limits.clips) return toolText(`Clip limit (${limits.clips}) reached; use what you have.`);
          const n = ++used.clips;
          try {
            const out = await generate({
              kind: "video",
              model: CLIP_MODEL,
              prompt,
              params: { aspect_ratio, duration_secs, resolution: "1080p", generate_audio: true, negative_prompt },
              out: path.join(bag.dir, `clip-${n}`),
              postId: bag.postId,
            });
            const name = path.basename(out.file);
            bag.files[name] = out.file;
            const probe = await probeVideo(out.file);
            const sheet = path.join(bag.dir, `clip-${n}-sheet.png`);
            const every = Math.max(1, Math.floor((probe.duration * probe.fps) / 4));
            await run("ffmpeg", ["-v", "error", "-y", "-i", out.file, "-vf", `select='not(mod(n\\,${every}))',scale=480:-2,tile=4x1`, "-frames:v", "1", sheet]);
            return toolImage(sheet, `Generated ${name}: ${probe.duration.toFixed(1)} s, ${probe.width}x${probe.height}, ${probe.acodec ? "with sound" : "silent"}. Four frames across it shown above. Use it as a video layer with src "${name}".`);
          } catch (e) {
            return failed(e);
          }
        },
      ),
    );

  if (limits.music)
    tools.push(
      tool(
        "generate_music",
        `Generate one instrumental music track on ElevenLabs (about a minute). Up to ${limits.music} per post. You cannot hear it: describe it well.`,
        {
          prompt: z.string().describe("Genre, instruments, tempo, energy curve over time, mood; no vocals"),
          seconds: z.number().min(5).max(60),
        },
        async ({ prompt, seconds }) => {
          if (used.music >= limits.music) return toolText(`Music limit (${limits.music}) reached.`);
          const n = ++used.music;
          try {
            const out = await generate({
              kind: "music",
              model: MUSIC_MODEL,
              prompt,
              params: { duration_seconds: Math.ceil(seconds), instrumental: true, lyrics_type: "instrumental" },
              out: path.join(bag.dir, `music-${n}`),
              postId: bag.postId,
            });
            const name = path.basename(out.file);
            bag.files[name] = out.file;
            const probe = await probeVideo(out.file);
            return toolText(`Generated ${name}: ${probe.duration.toFixed(1)} s. Use it as an audio layer with src "${name}".`);
          } catch (e) {
            return failed(e);
          }
        },
      ),
    );

  return tools;
}
