// Code reload for the long-running daemon: watch the sources that are loaded once per process and ask for a
// restart when they change. Product files, image templates and the dashboard's public/ are read on every use,
// so they apply without a restart and are not watched.
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.ts";
import { ROOT } from "./paths.ts";

const WATCHED_DIRS = ["src", "remotion/src"];
const WATCHED_FILES = [".env", "package.json", "pnpm-lock.yaml"];
const IGNORED = [path.join("src", "dashboard", "public") + path.sep];
const DEBOUNCE_MS = 1000;

/** Call `onChange` once (debounced) after any watched file changes. Returns a function that stops watching. */
export function watchSources(onChange: (file: string) => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let last = "";
  const changed = (rel: string) => {
    if (IGNORED.some((p) => rel.startsWith(p))) return;
    last = rel;
    clearTimeout(timer);
    timer = setTimeout(() => onChange(last), DEBOUNCE_MS);
  };

  const watchers: fs.FSWatcher[] = [];
  for (const dir of WATCHED_DIRS) {
    watchers.push(fs.watch(path.join(ROOT, dir), { recursive: true }, (_e, name) => name && changed(path.join(dir, name.toString()))));
  }
  // Watch the root dir (not the files) so editors that replace files by rename are still seen.
  watchers.push(fs.watch(ROOT, (_e, name) => name && WATCHED_FILES.includes(name.toString()) && changed(name.toString())));
  log.info({ dirs: WATCHED_DIRS, files: WATCHED_FILES }, "watching sources for changes");

  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
