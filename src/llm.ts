// Single seam to the LLM. The default adapter uses the Claude Agent SDK, which runs on the
// user's Claude Code subscription login (no API key needed).
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { logLlmCall } from "./core/db/index.ts";
import { log } from "./core/log.ts";

export type Model = "haiku" | "sonnet";

export interface CallOptions {
  /** Pipeline stage name; used for logging. */
  stage: string;
  model?: Model;
  system?: string;
  postId?: number;
  timeoutMs?: number;
}

interface AdapterResult {
  output: unknown;
  costUsd?: number;
}

type Adapter = (jsonSchema: object, prompt: string, opts: CallOptions) => Promise<AdapterResult>;

const DEFAULT_SYSTEM =
  "You are a senior social media strategist and copywriter working inside an automated content pipeline. " +
  "Follow the instructions exactly and answer only through the structured output.";

export class LlmError extends Error {}

/** Call the LLM and get back a zod-validated object. One retry on failure. */
export async function callJson<S extends z.ZodType>(schema: S, prompt: string, opts: CallOptions): Promise<z.infer<S>> {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  const model = opts.model ?? "sonnet";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const { output, costUsd } = await sdkAdapter(jsonSchema, prompt, opts);
      const parsed = schema.safeParse(output);
      if (!parsed.success) throw new LlmError(`Schema mismatch: ${parsed.error.message}`);
      logLlmCall({ post_id: opts.postId, stage: opts.stage, model, ms: Date.now() - t0, ok: true, cost_usd: costUsd });
      return parsed.data;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      logLlmCall({ post_id: opts.postId, stage: opts.stage, model, ms: Date.now() - t0, ok: false, error: msg.slice(0, 500) });
      log.warn({ stage: opts.stage, attempt, err: msg.slice(0, 300) }, "llm call failed");
    }
  }
  throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}

// ---------- Agent SDK adapter ----------

const sdkAdapter: Adapter = async (jsonSchema, prompt, opts) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "autocm-llm-"));
  // Without this, an API key in the environment would win over the subscription login.
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 300_000);
  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd,
        model: opts.model ?? "sonnet",
        systemPrompt: opts.system ?? DEFAULT_SYSTEM,
        outputFormat: { type: "json_schema", schema: jsonSchema as Record<string, unknown> },
        tools: [],
        // Keep the user's own settings, hooks, CLAUDE.md, plugins and MCP servers out of the prompt.
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: 4,
        env: childEnv,
        abortController: abort,
      },
    })) {
      if (msg.type !== "result") continue;
      if (msg.subtype !== "success" || msg.is_error || msg.structured_output === undefined) {
        const detail = "result" in msg ? msg.result : "errors" in msg ? JSON.stringify(msg.errors) : "";
        throw new LlmError(`agent sdk failed (${msg.subtype}): ${String(detail).slice(0, 400)}`);
      }
      return { output: msg.structured_output, costUsd: msg.total_cost_usd };
    }
    throw new LlmError("agent sdk returned no result");
  } catch (err) {
    if (abort.signal.aborted) throw new LlmError(`agent sdk timed out after ${opts.timeoutMs ?? 300_000} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
