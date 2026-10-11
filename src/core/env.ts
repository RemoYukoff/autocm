import dotenv from "dotenv";
import path from "node:path";
import { ROOT } from "./paths.ts";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

export const env = {
  globalDailyCap: Number(process.env.AUTOCM_GLOBAL_DAILY_CAP ?? 6),
  openaiKey: process.env.OPENAI_API_KEY || undefined,
  geminiKey: process.env.GEMINI_API_KEY || undefined,
  falKey: process.env.FAL_KEY || undefined,
  aiVideo: process.env.AUTOCM_AI_VIDEO === "1",
  logLevel: process.env.LOG_LEVEL ?? "info",
};
