// Single seam to the LLM. Default adapter shells out to `claude -p` so it runs on the
// user's Claude Code subscription (no API key). Swapping to the Anthropic API means
// replacing `claudeCliAdapter` only.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { logLlmCall } from "./core/db/index.ts";
import { env } from "./core/env.ts";
import { log } from "./core/log.ts";
import { FIXTURES_DIR } from "./core/paths.ts";

export type Model = "haiku" | "sonnet" | "opus";

export interface CallOptions {
  /** Pipeline stage name; used for logging and FakeLLM fixtures. */
  stage: string;
  model?: Model;
  system?: string;
  /** Tools the model may use. Only "Read" makes sense here (to look at images). */
  tools?: "Read"[];
  /** Working directory for the CLI. Files the model must Read should live under it or addDirs. */
  cwd?: string;
  addDirs?: string[];
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
  const adapter = env.llm === "fake" ? fakeAdapter : claudeCliAdapter;
  const model = opts.model ?? "sonnet";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const { output, costUsd } = await adapter(jsonSchema, prompt, opts);
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

// ---------- claude -p adapter ----------

const claudeCliAdapter: Adapter = (jsonSchema, prompt, opts) => {
  const cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "autocm-llm-"));
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(jsonSchema),
    "--model", opts.model ?? "sonnet",
    "--no-session-persistence",
    // Keep the user's own settings, hooks, CLAUDE.md, plugins and MCP servers out of the prompt.
    "--setting-sources", "",
    "--strict-mcp-config",
    "--system-prompt", opts.system ?? DEFAULT_SYSTEM,
    "--tools", (opts.tools ?? []).join(","),
  ];
  if (opts.tools?.length) args.push("--allowedTools", opts.tools.join(","));
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);

  // Without this, an API key in the environment would win over the subscription login.
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new LlmError(`claude -p timed out after ${opts.timeoutMs ?? 300_000} ms`));
    }, opts.timeoutMs ?? 300_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let msg: { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; total_cost_usd?: number };
      try {
        msg = JSON.parse(stdout);
      } catch {
        return reject(new LlmError(`claude -p exited ${code}, unparseable output: ${(stderr || stdout).slice(0, 400)}`));
      }
      if (msg.is_error || msg.subtype !== "success" || msg.structured_output === undefined) {
        return reject(new LlmError(`claude -p failed (${msg.subtype}): ${String(msg.result ?? stderr).slice(0, 400)}`));
      }
      resolve({ output: msg.structured_output, costUsd: msg.total_cost_usd });
    });
    child.stdin.end(prompt);
  });
};

// ---------- fake adapter (tests, offline dev) ----------

type FakeHandler = (prompt: string, opts: CallOptions) => unknown;
const fakeHandlers = new Map<string, FakeHandler>();

/** Register a canned response for a stage when AUTOCM_LLM=fake. */
export function setFakeResponse(stage: string, handler: FakeHandler | unknown): void {
  fakeHandlers.set(stage, typeof handler === "function" ? (handler as FakeHandler) : () => handler);
}

const fakeAdapter: Adapter = async (_schema, prompt, opts) => {
  const handler = fakeHandlers.get(opts.stage);
  if (handler) return { output: handler(prompt, opts) };
  const file = path.join(FIXTURES_DIR, "llm", `${opts.stage}.json`);
  if (fs.existsSync(file)) return { output: JSON.parse(fs.readFileSync(file, "utf8")) };
  throw new LlmError(`FakeLLM: no handler or fixture for stage "${opts.stage}" (${file})`);
};
