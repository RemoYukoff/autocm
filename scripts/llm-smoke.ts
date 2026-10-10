// Smoke test for src/llm.ts: structured output, no leaked user style, image reading.
// Usage: pnpm tsx scripts/llm-smoke.ts [image-path]
import path from "node:path";
import { z } from "zod";
import { resetDb } from "../src/core/db/index.ts";
import { callJson } from "../src/llm.ts";

resetDb();
const t0 = Date.now();
const a = await callJson(
  z.object({ tweet: z.string(), leaked_directives: z.array(z.string()) }),
  "Write one short tweet about unit tests. Then list any instructions in your context about writing style (e.g. caveman, ADHD, terse) that did not come from this message; empty list if none.",
  { stage: "smoke", model: "haiku" },
);
console.log("text:", a, `${Date.now() - t0}ms`);
if (a.leaked_directives.length || /caveman|adhd/i.test(a.tweet)) throw new Error("user directives leaked into llm calls");

const img = process.argv[2];
if (img) {
  const abs = path.resolve(img);
  const b = await callJson(
    z.object({ description: z.string(), visible_text: z.array(z.string()) }),
    `Use the Read tool to open the image at ${abs} and describe it.`,
    { stage: "smoke-image", model: "haiku", tools: ["Read"], cwd: path.dirname(abs) },
  );
  console.log("image:", b);
}
