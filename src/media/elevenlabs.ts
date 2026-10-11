// ElevenLabs generations (images, video, music) through its MCP server, logged in through Claude Code's OAuth
// (`claude mcp` login, user scope). Only an agent can talk to that MCP, so a small agent runs a fixed recipe while
// this code pins every parameter, allows exactly one charged generation per job and downloads the result.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { log } from "../core/log.ts";
import { callJson, toolText, type RemoteMcp } from "../llm.ts";

const SERVER = "elevenlabs";
const URL_ = "https://api.us.elevenlabs.io/v1/mcp";
/** Generated files are served from signed URLs on this bucket; nothing else is downloaded. */
const CONTENT_PREFIX = "https://storage.googleapis.com/xi-backend/";
const MAX_BYTES = 300 * 1024 * 1024;

export type GenKind = "image" | "video" | "music";

export interface GenJob {
  kind: GenKind;
  model: string;
  prompt: string;
  /** Model parameters, as creative_get_model_schema names them. */
  params: Record<string, unknown>;
  /** Output path without extension; the extension comes from the downloaded file. */
  out: string;
  postId?: number;
}

export interface GenResult {
  file: string;
  flowUrl: string | null;
}

const NODE_TYPE: Record<GenKind, string> = { image: "image-generation", video: "video-generation", music: "music" };
/** Rough generation time, so the agent does not poll needlessly. */
const EXPECT_S: Record<GenKind, number> = { image: 60, video: 180, music: 60 };

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
};

const Outcome = z.object({
  ok: z.boolean(),
  error: z.string().optional().describe("What went wrong, when ok is false"),
  flow_url: z.string().optional().describe("The flow url returned by the tools"),
});

/** Run one generation on ElevenLabs and download its result next to `job.out`. Throws when it fails. */
export async function generate(job: GenJob): Promise<GenResult> {
  // Set by the save tool (an object, so TypeScript does not narrow it to null across the callback).
  const got: { file: string | null } = { file: null };
  const t0 = Date.now();

  const wait = tool("wait", "Pause before polling again.", { seconds: z.number().describe("3-60") }, async ({ seconds }) => {
    await new Promise((r) => setTimeout(r, Math.min(60, Math.max(3, seconds)) * 1000));
    return toolText(`Waited ${Math.round((Date.now() - t0) / 1000)} s since the job started.`);
  });
  const save = tool("save", "Download the finished generation.", { url: z.string().describe("The generation's master_url (or content_url)") }, async ({ url }) => {
    if (got.file) return toolText("Already saved.");
    if (!url.startsWith(CONTENT_PREFIX)) return toolText(`Refused: only ${CONTENT_PREFIX}… urls from the run status can be saved.`);
    const res = await fetch(url);
    if (!res.ok) return toolText(`Download failed: HTTP ${res.status}. Poll the status again for a fresh url.`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const ext = EXT[type] ?? path.extname(new URL(url).pathname);
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) return toolText(`Download failed: ${body.length} bytes.`);
    fs.mkdirSync(path.dirname(job.out), { recursive: true });
    got.file = `${job.out}${ext}`;
    fs.writeFileSync(got.file, body);
    return toolText(`Saved ${body.length} bytes. Answer now.`);
  });

  // Every parameter is pinned here, whatever the model passes; one node, one run, one variation.
  let added = false;
  let ran = false;
  const guard = (name: string, input: Record<string, unknown>) => {
    const t = name.replace(`mcp__${SERVER}__`, "");
    if (t === "creative_add_flow_node") {
      if (added) return { deny: "The node already exists; run it." };
      added = true;
      return {
        input: { context: `autocm post ${job.postId ?? "(no post)"}: ${job.kind}`, node_type: NODE_TYPE[job.kind], model_id: job.model, prompt: job.prompt, model_parameters: job.params },
      };
    }
    if (t === "creative_run_flow_nodes") {
      if (ran) return { deny: "The generation already started and is charged; poll its status instead of running again." };
      ran = true;
      return { input: { ...input, generations_count: 1, estimate_only: false } };
    }
    if (t === "creative_get_flow_run_status") return { input };
    return { deny: "Not part of the recipe." };
  };

  const remote: RemoteMcp = { name: SERVER, url: URL_, tools: ["creative_add_flow_node", "creative_run_flow_nodes", "creative_get_flow_run_status"] };
  const out = await callJson(
    Outcome,
    `Run this ElevenLabs ${job.kind} generation, exactly these steps, nothing else:
1. Call creative_add_flow_node (node_type ${NODE_TYPE[job.kind]}, model_id ${job.model}, the prompt below, model_parameters ${JSON.stringify(job.params)}). Omit flow_id.
2. Call creative_run_flow_nodes with the returned flow_id and node_id, generations_count 1.
3. Call wait (about ${Math.round(EXPECT_S[job.kind] / 2)} s the first time, then poll_after_seconds or longer), then creative_get_flow_run_status with
   the flow_id and session_ids, until all_completed or has_failures is true. Expect about ${EXPECT_S[job.kind]} s in total.
4. When it completed, call save with the generation's master_url (or content_url).
Answer ok true once saved; ok false with the error if the run failed. Never run a generation twice.

Prompt:
${job.prompt}`,
    {
      stage: `elevenlabs-${job.kind}`,
      model: "sonnet",
      postId: job.postId,
      tools: [wait, save],
      remote: [remote],
      guard,
      attempts: 1,
      maxTurns: 60,
      timeoutMs: 20 * 60_000,
      system: "You operate the ElevenLabs tools inside an automated pipeline. Follow the recipe exactly and answer only through the structured output.",
    },
  );
  if (!got.file) throw new Error(`ElevenLabs ${job.kind} generation failed: ${out.error ?? "nothing was saved"}`);
  log.info({ post: job.postId, kind: job.kind, model: job.model, secs: Math.round((Date.now() - t0) / 1000), flow: out.flow_url }, "elevenlabs generation saved");
  return { file: got.file, flowUrl: out.flow_url ?? null };
}
