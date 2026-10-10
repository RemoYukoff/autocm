import pino from "pino";
import { env } from "./env.ts";

export const log = pino({
  level: env.logLevel,
  transport: process.stdout.isTTY ? { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname" } } : undefined,
});
