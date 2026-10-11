// Single seam to the LLM. The default adapter uses the Claude Agent SDK, which runs on the
// user's Claude Code subscription login (no API key needed).
import { createSdkMcpServer, query, type HookCallbackMatcher, type McpServerConfig, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { logLlmCall } from "./core/db/index.ts";
import { log } from "./core/log.ts";

export type Model = "haiku" | "sonnet" | "opus";

/** A tool made with the Agent SDK's `tool()`. */
export type AgentTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>[number];

export interface CallOptions {
  /** Pipeline stage name; used for logging. */
  stage: string;
  model?: Model;
  system?: string;
  postId?: number;
  timeoutMs?: number;
  /** PNG/JPEG/WebP files shown to the model before the prompt text. */
  images?: string[];
  /** In-process tools the model may call (exposed as mcp__autocm__<name>). */
  tools?: AgentTool[];
  /** Agent turns; each tool call takes one. */
  maxTurns?: number;
  /** Tries before giving up (default 2). Calls whose tools keep state retry on their own instead. */
  attempts?: number;
  /** Remote MCP servers (logged in through Claude Code's own OAuth) and the only tools the call may use from each. */
  remote?: RemoteMcp[];
  /**
   * Checked before every remote tool call: return `{ deny }` to refuse it (the model sees the reason) or
   * `{ input }` to run it with a rewritten input.
   */
  guard?: (tool: string, input: Record<string, unknown>) => { deny: string } | { input: Record<string, unknown> };
}

export interface RemoteMcp {
  name: string;
  url: string;
  tools: string[];
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
  const attempts = opts.attempts ?? 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
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

/** Text tool result for an AgentTool handler. */
export function toolText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Image (plus optional text) tool result for an AgentTool handler. */
export function toolImage(file: string, text?: string) {
  return {
    content: [
      { type: "image" as const, data: fs.readFileSync(file).toString("base64"), mimeType: imageMime(file) },
      ...(text ? [{ type: "text" as const, text }] : []),
    ],
  };
}

function imageMime(file: string): "image/png" | "image/jpeg" | "image/webp" {
  const ext = path.extname(file).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
}

// ---------- Agent SDK adapter ----------

const SERVER = "autocm";

async function* userMessage(prompt: string, images: string[]): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        ...images.map((f) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: imageMime(f), data: fs.readFileSync(f).toString("base64") },
        })),
        { type: "text" as const, text: prompt },
      ],
    },
  };
}

function guardHook(guard: NonNullable<CallOptions["guard"]>): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        // Only remote MCP tools are guarded; our own tools and the SDK's (StructuredOutput) pass untouched.
        if (input.hook_event_name !== "PreToolUse" || !input.tool_name.startsWith("mcp__") || input.tool_name.startsWith(`mcp__${SERVER}__`)) return {};
        const verdict = guard(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        return {
          hookSpecificOutput:
            "deny" in verdict
              ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.deny }
              : { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: verdict.input },
        };
      },
    ],
  };
}

const sdkAdapter: Adapter = async (jsonSchema, prompt, opts) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "autocm-llm-"));
  // Without this, an API key in the environment would win over the subscription login.
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  const tools = opts.tools ?? [];
  const remote = opts.remote ?? [];
  const images = opts.images ?? [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 300_000);
  try {
    for await (const msg of query({
      prompt: images.length ? userMessage(prompt, images) : prompt,
      options: {
        cwd,
        model: opts.model ?? "sonnet",
        systemPrompt: opts.system ?? DEFAULT_SYSTEM,
        outputFormat: { type: "json_schema", schema: jsonSchema as Record<string, unknown> },
        // No built-in tools; only our own in-process ones, allowed without asking.
        tools: [],
        mcpServers: {
          ...(tools.length ? { [SERVER]: createSdkMcpServer({ name: SERVER, tools }) } : {}),
          ...Object.fromEntries(remote.map((r): [string, McpServerConfig] => [r.name, { type: "http", url: r.url }])),
        },
        allowedTools: [...tools.map((t) => `mcp__${SERVER}__${t.name}`), ...remote.flatMap((r) => r.tools.map((t) => `mcp__${r.name}__${t}`))],
        hooks: opts.guard ? { PreToolUse: [guardHook(opts.guard)] } : {},
        permissionMode: "dontAsk",
        // Keep the user's own settings, hooks, CLAUDE.md, plugins and MCP servers out of the prompt.
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: opts.maxTurns ?? 4,
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
    fs.rmSync(cwd, { recursive: true, force: true });
  }
};
