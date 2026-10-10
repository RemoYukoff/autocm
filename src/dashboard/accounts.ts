// Accounts in the dashboard: connect / disconnect a product's X session and "Fill from website" drafts.
// Both run as background jobs wrapped in track(), so the service's code-reload restarter waits for them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProductSlugs } from "../core/config.ts";
import { deleteProductData, deleteXAccount, getXAccount, logEvent, nowIso, saveXAccount } from "../core/db/index.ts";
import { track } from "../core/inflight.ts";
import { log } from "../core/log.ts";
import { OUT_DIR, PRODUCTS_DIR, sessionDir } from "../core/paths.ts";
import type { XAccount } from "../core/types.ts";
import { draftFromWebsite, normalizeSiteUrl, type ProductDraft } from "../products/prefill.ts";
import { createProduct, productDir, SLUG_RE, validateCreate } from "../products/write.ts";
import { currentTick } from "../scheduler/tick.ts";
import { connectWithBrowser, connectX, disconnectX } from "../x/index.ts";
import { ActionError } from "./actions.ts";

export interface AccountJob {
  id: number;
  kind: "create" | "connect" | "prefill";
  /** Product slug (create, connect) or null (prefill: the product does not exist yet). */
  product: string | null;
  url: string | null;
  status: "running" | "done" | "failed";
  step: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const jobs = new Map<number, { job: AccountJob; done: Promise<void>; draft: ProductDraft | null }>();
let nextId = 1;
const KEEP = 20;

function start(meta: Pick<AccountJob, "kind" | "product" | "url">, run: (job: AccountJob) => Promise<ProductDraft | null>): AccountJob {
  const job: AccountJob = { id: nextId++, ...meta, status: "running", step: null, error: null, started_at: nowIso(), finished_at: null };
  const entry = { job, done: Promise.resolve(), draft: null as ProductDraft | null };
  entry.done = track(
    (async () => {
      try {
        entry.draft = await run(job);
        job.status = "done";
      } catch (e) {
        job.status = "failed";
        job.error = (e as Error).message;
        log.warn({ job: job.id, kind: job.kind, err: job.error }, "account job failed");
      } finally {
        job.step = null;
        job.finished_at = nowIso();
        prune();
      }
    })(),
  );
  jobs.set(job.id, entry);
  return job;
}

function prune(): void {
  const finished = [...jobs.values()].filter((j) => j.job.status !== "running").sort((a, b) => b.job.id - a.job.id);
  for (const j of finished.slice(KEEP)) jobs.delete(j.job.id);
}

export function listAccountJobs(): AccountJob[] {
  return [...jobs.values()].map((j) => j.job).sort((a, b) => b.id - a.id);
}

export function getAccountJob(id: number): { job: AccountJob; draft: ProductDraft | null } | null {
  const j = jobs.get(id);
  return j ? { job: j.job, draft: j.draft } : null;
}

/** Tests / shutdown: wait for every account job started so far. */
export async function settleAccountJobs(): Promise<void> {
  await Promise.all([...jobs.values()].map((j) => j.done));
}

/** Tests: forget all account jobs. */
export function resetAccountJobs(): void {
  jobs.clear();
  nextId = 1;
}

function requireProduct(slug: string): void {
  if (!SLUG_RE.test(slug) || !listProductSlugs().includes(slug)) throw new ActionError(404, `unknown product "${slug}"`);
}

function running(kind: AccountJob["kind"], product: string | null): AccountJob | undefined {
  return listAccountJobs().find((j) => j.kind === kind && j.product === product && j.status === "running");
}

/** Open the login window for the product's X account (the user logs in there). */
export function startConnect(slug: string): AccountJob {
  requireProduct(slug);
  if (running("connect", slug)) throw new ActionError(409, `already connecting ${slug}: finish logging in in the window that opened`);
  return start({ kind: "connect", product: slug, url: null }, async (job) => {
    job.step = "Log in to X in the window that opened";
    const account = await connectX(slug);
    log.info({ product: slug, handle: account.handle }, "X connected from dashboard");
    return null;
  });
}

/**
 * Add an account: validate the form, open the X login window, and write the product only once the login succeeded.
 * Cancelled or failed logins leave nothing behind (no product folder, no session, no account row).
 */
export function startCreate(body: Record<string, unknown>): AccountJob {
  const slug = validateCreate(body.slug, body);
  if (listAccountJobs().some((j) => j.kind === "create" && j.product === slug && j.status === "running")) {
    throw new ActionError(409, `already adding ${slug}: finish logging in in the window that opened`);
  }
  return start({ kind: "create", product: slug, url: null }, async (job) => {
    // A session left by an abandoned attempt could belong to another X account: always start from a clean profile.
    fs.rmSync(sessionDir(slug), { recursive: true, force: true });
    deleteXAccount(slug);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "autocm-avatar-"));
    try {
      job.step = "Log in to X in the window that opened";
      const account = await connectWithBrowser(slug, { avatarDir: stage });
      job.step = "Saving the account";
      createProduct(slug, body);
      if (account.avatar_path) {
        const dest = path.join(productDir(slug), "assets", path.basename(account.avatar_path));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(account.avatar_path, dest);
        saveXAccount({ ...account, avatar_path: dest });
      }
      logEvent("product_created", { product: slug, payload: { source: "dashboard", handle: account.handle } });
      log.info({ product: slug, handle: account.handle }, "account added");
      return null;
    } catch (e) {
      fs.rmSync(sessionDir(slug), { recursive: true, force: true });
      deleteXAccount(slug);
      throw e;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
}

/** Delete an account: its product folder, X session, generated files and every row about it. */
export async function deleteAccount(slug: string): Promise<void> {
  requireProduct(slug);
  if (listAccountJobs().some((j) => j.product === slug && j.status === "running")) throw new ActionError(409, `${slug} is busy; try again when it finishes`);
  if (currentTick()) throw new ActionError(409, "the scheduler is writing or publishing right now; try again in a minute");
  await disconnectX(slug);
  fs.rmSync(productDir(slug), { recursive: true, force: true });
  fs.rmSync(path.join(OUT_DIR, slug), { recursive: true, force: true });
  deleteProductData(slug);
  log.info({ product: slug }, "account deleted");
}

/** Read the website in the background and keep the draft until the form asks for it. */
export function startPrefill(rawUrl: unknown): AccountJob {
  let url: URL;
  try {
    url = normalizeSiteUrl(rawUrl);
  } catch (e) {
    throw new ActionError(400, (e as Error).message);
  }
  const busy = listAccountJobs().filter((j) => j.kind === "prefill" && j.status === "running");
  if (busy.length >= 2) throw new ActionError(409, "two website reads are already running; wait for one to finish");
  return start({ kind: "prefill", product: null, url: url.href }, (job) =>
    draftFromWebsite(url.href, (step) => {
      job.step = step;
    }),
  );
}

// ---------- files the UI shows ----------

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

function within(root: string, file: string): string | null {
  try {
    const real = fs.realpathSync(file);
    const base = fs.realpathSync(root);
    if (!real.startsWith(base + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** The account's avatar, only if it is an image inside products/<slug>/. */
export function avatarFile(slug: string, account: XAccount | null = SLUG_RE.test(slug) ? getXAccount(slug) : null): string | null {
  if (!account?.avatar_path || !SLUG_RE.test(slug)) return null;
  if (!IMAGE_EXT.has(path.extname(account.avatar_path).toLowerCase())) return null;
  return within(path.join(PRODUCTS_DIR, slug), path.resolve(PRODUCTS_DIR, slug, account.avatar_path));
}

/** An image or video under products/<slug>/assets/ (logo, screens, clips previews). */
export function productAssetFile(slug: string, rel: string): string | null {
  if (!SLUG_RE.test(slug) || typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel)) return null;
  if (rel.split(/[\\/]+/).includes("..")) return null;
  const ext = path.extname(rel).toLowerCase();
  if (!IMAGE_EXT.has(ext) && ![".mp4", ".mov", ".webm"].includes(ext)) return null;
  return within(path.join(PRODUCTS_DIR, slug, "assets"), path.resolve(PRODUCTS_DIR, slug, rel));
}
