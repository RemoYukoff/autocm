import dotenv from "dotenv";
import path from "node:path";
import { ROOT } from "./paths.ts";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

export const env = {
  globalDailyCap: Number(process.env.AUTOCM_GLOBAL_DAILY_CAP ?? 6),
  logLevel: process.env.LOG_LEVEL ?? "info",
};
