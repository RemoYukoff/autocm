#!/usr/bin/env tsx
import { Command } from "commander";
import { capabilitiesFor, listProductSlugs, loadProduct, validateProductFiles } from "./core/config.ts";
import { getDb } from "./core/db/index.ts";
import { env } from "./core/env.ts";
import { log } from "./core/log.ts";
import { renderFixture } from "./media/index.ts";
import { xWhoami } from "./publish/index.ts";
import { isPaused, pause, resume } from "./safety/pause.ts";
import { planSlots, runDaemon, tick } from "./scheduler/index.ts";
import { DEFAULT_PORT, startDashboard } from "./dashboard/server.ts";
import { currentTick } from "./scheduler/tick.ts";
import { inFlight } from "./core/inflight.ts";
import { connectX } from "./x/index.ts";
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
    console.log(`${slug}\tenabled=${p.config.enabled}\tx=${p.xAccount ? `@${p.xAccount.handle}` : "not connected"}\tcaps=${JSON.stringify(caps)}`);
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

program.command("plan").option("-d, --days <n>", "days ahead", "1").description("Create posting slots").action(async (o: { days: string }) => {
  console.log(`${await planSlots(Number(o.days))} slots created`);
});
program.command("tick").description("Run one scheduler pass").action(tick);
/** On a source change, wait until no tick or publish is running, then stop the daemon via SIGTERM. */
function restartWhenIdle(): () => void {
  let poll: NodeJS.Timeout | undefined;
  const idle = () => !currentTick() && !inFlight();
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
    }
    if (o.watch) process.exit(0);
  });

program
  .command("dashboard")
  .description("Local web dashboard: preview upcoming posts and veto them")
  .option("-p, --port <port>", "port", String(DEFAULT_PORT))
  .action((o: { port: string }) => {
    startDashboard(portArg(o.port), () => {
      process.exitCode = 1;
    });
  });

program.command("pause <product>").description("Stop publishing for one account").action((slug: string) => {
  pause(loadProduct(slug).config.slug);
  console.log(`${slug} paused`);
});
program.command("resume <product>").description("Resume publishing for one account").action((slug: string) => {
  resume(loadProduct(slug).config.slug);
  console.log(`${slug} resumed`);
});

program
  .command("render-fixture <file>")
  .requiredOption("-p, --product <slug>", "product")
  .description("Render media for a {brief, draft} fixture without the LLM")
  .action(async (file: string, o: { product: string }) => {
    console.log(JSON.stringify(await renderFixture(file, o.product), null, 2));
  });

const x = program.command("x").description("X account through the logged-in browser profile");
x.command("connect <product>")
  .description("Open a browser window to log in to X for this product (stop the service first: the profile is locked while it runs)")
  .action(async (slug: string) => {
    loadProduct(slug);
    const a = await connectX(slug);
    console.log(`connected @${a.handle}`);
  });
x.command("whoami <product>").description("Profile of the product's logged-in X session").action(async (slug: string) => {
  console.log(await xWhoami(loadProduct(slug)));
});
program.command("status").description("LLM mode and each account's pause state").action(() => {
  console.log(`llm=${env.llm}`);
  for (const slug of listProductSlugs()) console.log(`${slug} paused=${isPaused(slug) ? "yes" : "no"}`);
});

program.parseAsync().catch((e: Error) => {
  log.error(e.message);
  process.exitCode = 1;
});
