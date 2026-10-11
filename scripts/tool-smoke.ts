// Smoke test for tool calls and image input through src/llm.ts.
// Usage: pnpm tsx scripts/tool-smoke.ts <png>
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resetDb } from "../src/core/db/index.ts";
import { callJson, toolImage } from "../src/llm.ts";

resetDb();
const png = process.argv[2]!;
let calls = 0;
const show = tool("show_picture", "Returns the picture to describe.", { reason: z.string() }, async () => {
  calls++;
  return toolImage(png, "This is the picture.");
});
const out = await callJson(
  z.object({ seen_in_prompt: z.string(), seen_from_tool: z.string() }),
  "Describe in a few words the image attached to this message (seen_in_prompt). Then call show_picture once and describe what it returns (seen_from_tool).",
  { stage: "smoke", model: "haiku", images: [png], tools: [show], maxTurns: 4 },
);
console.log(out, { calls });
if (calls !== 1) throw new Error("tool was not called exactly once");
