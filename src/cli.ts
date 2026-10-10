#!/usr/bin/env tsx
import { Command } from "commander";
import { capabilitiesFor, listProductSlugs, loadProduct, validateProductFiles } from "./core/config.ts";
import { getDb, getPost, recentPosts } from "./core/db/index.ts";
import { env } from "./core/env.ts";
import { log } from "./core/log.ts";
import { Format } from "./core/types.ts";
import { renderFixture } from "./media/index.ts";
import { generatePost } from "./pipeline.ts";
import { publishPost, xWhoami } from "./publish/index.ts";
import { pause, pausedReason, resume } from "./safety/pause.ts";
import { planSlots, runDaemon, tick } from "./scheduler/index.ts";
import { listJobs, lockedKeys, settleJobs } from "./dashboard/actions.ts";
import { DEFAULT_PORT, startDashboard } from "./dashboard/server.ts";
import { currentTick } from "./scheduler/tick.ts";
import { watchSources } from "./core/watch.ts";

const program = new Command().name("autocm").description("Autonomous X community manager");

program.command("init-db").description("Create the SQLite database").action(() => {
  getDb();
  console.log("db ready");
});

const products = program.command("products").description("Manage products");
products.command("list").action(() => {
  for (const slug of listProductSlugs()) {
    const p = loadProduct(slug);
    const caps = capabilitiesFor(p);
    console.log(`${slug}\tenabled=${p.config.enabled}\tx_creds=${p.xCreds ? "yes" : "no"}\tcaps=${JSON.stringify(caps)}`);
  }
});
products.command("validate [slug]").description("Validate product.yaml and referenced files").action((slug?: string) => {
  let bad = 0;
  for (const s of slug ? [slug] : listProductSlugs()) {
    try {
      const problems = validateProductFiles(loadProduct(s));
      if (problems.length) {
        bad++;
        console.log(`✗ ${s}\n  - ${problems.join("\n  - ")}`);
      } else console.log(`✓ ${s}`);
    } catch (e) {
      bad++;
      console.log(`✗ ${s}: ${(e as Error).message}`);
    }
  }
  process.exitCode = bad ? 1 : 0;
});

program
  .command("generate <product>")
  .description("Generate one post (strategist decides format unless --format). Does not publish unless --publish")
  .option("-f, --format <format>", "text | image | video")
  .option("--publish", "publish right after generation (dry-run unless AUTOCM_MODE=live)")
  .action(async (slug: string, o: { format?: string; publish?: boolean }) => {
    const format = o.format ? Format.parse(o.format) : undefined;
    const post = await generatePost(slug, { format });
    console.log(`post #${post.id} ${post.status} ${post.format}/${post.media_kind}\n${post.text ?? ""}\n${post.out_dir ?? ""}`);
    if (o.publish && post.status === "approved") {
      const res = await publishPost(post, loadProduct(slug));
      console.log(res);
    }
  });

program.command("publish <postId>").description("Publish an approved post now (guards still apply)").action(async (id: string) => {
  const post = getPost(Number(id));
  if (!post) throw new Error(`post ${id} not found`);
  console.log(await publishPost(post, loadProduct(post.product)));
});

program.command("plan").option("-d, --days <n>", "days ahead", "1").description("Create posting slots").action(async (o: { days: string }) => {
  console.log(`${await planSlots(Number(o.days))} slots created`);
});
program.command("tick").description("Run one scheduler pass").action(tick);
/** On a source change, wait until no tick or dashboard job is running, then stop the daemon via SIGTERM. */
function restartWhenIdle(): () => void {
  let poll: NodeJS.Timeout | undefined;
  const idle = () => !currentTick() && !lockedKeys().length && !listJobs().some((j) => j.status === "running");
  const stopWatching = watchSources((file) => {
    if (poll) return;
    log.info({ file }, "source changed: restarting once idle");
    const check = () => {
      if (!idle()) return;
      clearInterval(poll);
      process.kill(process.pid, "SIGTERM");
    };
    poll = setInterval(check, 2000);
    check();
  });
  return () => {
    clearInterval(poll);
    stopWatching();
  };
}

const portArg = (v: string | true | undefined): number => {
  const port = v === undefined || v === true ? DEFAULT_PORT : Number(v);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad port "${String(v)}"`);
  return port;
};

program
  .command("run")
  .description("Run the scheduler daemon")
  .option("--dashboard [port]", `also serve the dashboard on 127.0.0.1 (default port ${DEFAULT_PORT})`)
  .option("--watch", "exit once idle after a source file changes (the service manager restarts it with the new code)")
  .action(async (o: { dashboard?: string | true; watch?: boolean }) => {
    const server = o.dashboard ? startDashboard(portArg(o.dashboard)) : null;
    const unwatch = o.watch ? restartWhenIdle() : null;
    try {
      await runDaemon();
    } finally {
      unwatch?.();
      server?.close();
      await settleJobs();
    }
    if (o.watch) process.exit(0);
  });

program
  .command("dashboard")
  .description("Local web dashboard: preview upcoming posts, veto, regenerate, publish now")
  .option("-p, --port <port>", "port", String(DEFAULT_PORT))
  .action((o: { port: string }) => {
    startDashboard(portArg(o.port), () => {
      process.exitCode = 1;
    });
  });

program.command("pause [reason...]").description("Stop all publishing").action((reason: string[] = []) => {
  pause(reason.join(" ") || "manual");
  console.log("paused");
});
program.command("resume").description("Resume publishing").action(() => {
  resume();
  console.log(pausedReason() ? `still paused: ${pausedReason()}` : "resumed");
});

program.command("history <product>").option("-n <n>", "how many", "20").action((slug: string, o: { n: string }) => {
  const rows = recentPosts(slug, Number(o.n), ["published", "dry_run", "approved", "rejected", "failed", "qa_failed", "generating", "publishing"]);
  for (const r of rows) {
    console.log(`#${r.id} ${r.status.padEnd(9)} ${(r.format ?? "-").padEnd(5)} ${(r.media_kind ?? "-").padEnd(8)} ${r.pillar ?? "-"} | ${(r.text ?? r.error ?? "").replace(/\s+/g, " ").slice(0, 90)}`);
  }
});

program
  .command("render-fixture <file>")
  .option("-p, --product <slug>", "product", "acme")
  .description("Render media for a {brief, draft} fixture without the LLM")
  .action(async (file: string, o: { product: string }) => {
    console.log(JSON.stringify(await renderFixture(file, o.product), null, 2));
  });

program.command("x <action> [product]").description("X utilities: whoami").action(async (action: string, slug = "acme") => {
  if (action !== "whoami") throw new Error(`unknown x action "${action}"`);
  console.log(await xWhoami(loadProduct(slug)));
});

program.command("status").description("Mode, pause state, products").action(() => {
  console.log(`mode=${env.mode} llm=${env.llm} paused=${pausedReason() ?? "no"}`);
});

program.parseAsync().catch((e: Error) => {
  log.error(e.message);
  process.exitCode = 1;
});
