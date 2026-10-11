// Accounts in the dashboard. Adding one is two steps, with no product settings exposed:
//   1. Add account: log in to X in a browser window; the handle becomes the account's slug.
//   2. Website: autocm reads the product's site and writes products/<slug>/ by itself, then plans posts.
// Every step runs as a background job wrapped in track(), so the service's code-reload restarter waits for it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listProductSlugs } from "../core/config.ts";
import { deleteProductData, deleteXAccount, getXAccount, logEvent, nowIso, saveXAccount } from "../core/db/index.ts";
import { track } from "../core/inflight.ts";
import { log } from "../core/log.ts";
import { ACCOUNTS_DIR, OUT_DIR, PRODUCTS_DIR, SESSIONS_DIR, sessionDir } from "../core/paths.ts";
import type { XAccount } from "../core/types.ts";
import { draftFromWebsite, logoExt, normalizeSiteUrl, type ProductDraft } from "../products/prefill.ts";
import { defaultCadence } from "../products/schema.ts";
import { productDir, ProductWriteError, slugify, SLUG_RE, writeProduct, type NewProduct } from "../products/write.ts";
import { planSlots } from "../scheduler/index.ts";
import { currentTick } from "../scheduler/tick.ts";
import { connectWithBrowser, disconnectX } from "../x/index.ts";
import { ActionError } from "./actions.ts";

export interface AccountJob {
  id: number;
  kind: "add" | "website" | "reconnect";
  /** Account slug; null while an add is still waiting for the login. */
  product: string | null;
  url: string | null;
  status: "running" | "done" | "failed";
  step: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const jobs = new Map<number, { job: AccountJob; done: Promise<void> }>();
let nextId = 1;
const KEEP = 20;

function start(meta: Pick<AccountJob, "kind" | "product" | "url">, run: (job: AccountJob) => Promise<void>): AccountJob {
  const job: AccountJob = { id: nextId++, ...meta, status: "running", step: null, error: null, started_at: nowIso(), finished_at: null };
  const entry = { job, done: Promise.resolve() };
  entry.done = track(
    (async () => {
      try {
        await run(job);
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

export function getAccountJob(id: number): AccountJob | null {
  return jobs.get(id)?.job ?? null;
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

function runningFor(slug: string): AccountJob | undefined {
  return listAccountJobs().find((j) => j.product === slug && j.status === "running");
}

const hasProduct = (slug: string) => listProductSlugs().includes(slug);

export function requireAccount(slug: string): void {
  if (!SLUG_RE.test(slug) || (!hasProduct(slug) && !getXAccount(slug))) throw new ActionError(404, `unknown account "${slug}"`);
}

/** data/accounts/<slug>/: the X avatar until the product folder exists. */
function stagingDir(slug: string): string {
  return path.join(ACCOUNTS_DIR, slug);
}

/** X handles are [A-Za-z0-9_]{1,15}; slugs are lowercase with dashes. */
export function slugFromHandle(handle: string): string {
  const slug = slugify(handle.replace(/_/g, "-"));
  return SLUG_RE.test(slug) ? slug : `x-${crypto.createHash("sha1").update(handle).digest("hex").slice(0, 8)}`;
}

// ---------- 1. add: log in to X ----------

/** Open the X login window in a fresh profile; once logged in, the account exists under its handle. */
export function startAdd(): AccountJob {
  if (listAccountJobs().some((j) => j.kind === "add" && j.status === "running")) {
    throw new ActionError(409, "an X login window is already open: finish logging in there first");
  }
  return start({ kind: "add", product: null, url: null }, async (job) => {
    // Profiles of logins that never finished (crash, restart) are useless: start clean.
    for (const d of fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : []) {
      if (d.startsWith("new-")) fs.rmSync(path.join(SESSIONS_DIR, d), { recursive: true, force: true });
    }
    const tmp = `new-${crypto.randomBytes(4).toString("hex")}`;
    try {
      job.step = "Log in to X in the window that opened";
      const account = await connectWithBrowser(tmp, { avatarDir: stagingDir(tmp) });
      deleteXAccount(tmp);
      const slug = slugFromHandle(account.handle);
      if (getXAccount(slug) || hasProduct(slug)) throw new Error(`@${account.handle} is already added`);

      fs.rmSync(sessionDir(slug), { recursive: true, force: true });
      fs.renameSync(sessionDir(tmp), sessionDir(slug));
      let avatar_path: string | null = null;
      if (account.avatar_path) {
        fs.rmSync(stagingDir(slug), { recursive: true, force: true });
        fs.renameSync(stagingDir(tmp), stagingDir(slug));
        avatar_path = path.join(stagingDir(slug), path.basename(account.avatar_path));
      }
      saveXAccount({ ...account, product: slug, avatar_path });
      job.product = slug;
      logEvent("account_added", { product: slug, payload: { handle: account.handle } });
      log.info({ product: slug, handle: account.handle }, "account added; waiting for its website");
    } finally {
      deleteXAccount(tmp);
      fs.rmSync(sessionDir(tmp), { recursive: true, force: true });
      fs.rmSync(stagingDir(tmp), { recursive: true, force: true });
    }
  });
}

// ---------- 2. website: write the product from the site ----------

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DEFAULT_COLORS: Record<string, string> = { primary: "#4F46E5", accent: "#818CF8", ink: "#09090B", bg: "#FAFAFA" };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const nonEmpty = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0;

/** Make the website draft valid on its own: nobody reviews it, so every gap gets a sane default. */
export function completeDraft(draft: ProductDraft, account: XAccount): NewProduct {
  const c = { ...draft.config };
  if (typeof c.name !== "string" || !c.name.trim()) c.name = account.name || account.handle;
  if (typeof c.one_liner !== "string" || !c.one_liner.trim()) c.one_liner = `${String(c.name)}, see ${String(c.url)}`;
  if (typeof c.audience !== "string" || !c.audience.trim()) c.audience = `People who would use ${String(c.name)}`;
  const voice = obj(c.voice);
  c.voice = { ...voice, rules: nonEmpty(voice.rules) ? voice.rules : ["Plain, concrete sentences. No hype."] };
  if (!nonEmpty(c.pillars)) c.pillars = [{ id: "product", description: `What ${String(c.name)} does, one concrete detail at a time`, weight: 1 }];
  c.cadence = defaultCadence();
  const brand = obj(c.brand);
  const colors = obj(brand.colors);
  const fixed: Record<string, string> = {};
  for (const [k, def] of Object.entries(DEFAULT_COLORS)) fixed[k] = typeof colors[k] === "string" && HEX.test(colors[k] as string) ? (colors[k] as string) : def;
  if (typeof colors.muted === "string" && HEX.test(colors.muted)) fixed.muted = colors.muted;
  const guidelines = nonEmpty(brand.guidelines) ? brand.guidelines : ["Clean, modern product look: plenty of space, one accent color, bold sans-serif headlines."];
  c.brand = { ...brand, colors: fixed, guidelines };

  // No logo on the site: the X avatar stands in, it always exists after the login.
  let logo = draft.logo;
  if (!logo && account.avatar_path && fs.existsSync(account.avatar_path)) {
    const data = fs.readFileSync(account.avatar_path);
    const ext = logoExt(data);
    if (ext) logo = { data, ext };
  }
  if (!logo) throw new Error("No logo on the website and no X avatar to use instead");
  return { config: c, knowledge: draft.knowledge, logo, reference: draft.reference };
}

/** Read the product's website and write products/<slug>/ from it, then plan posts. */
export function startWebsite(slug: string, rawUrl: unknown): AccountJob {
  requireAccount(slug);
  if (hasProduct(slug)) throw new ActionError(409, `${slug} already has its website set`);
  if (runningFor(slug)) throw new ActionError(409, `${slug} is busy; wait for it to finish`);
  let url: URL;
  try {
    url = normalizeSiteUrl(rawUrl);
  } catch (e) {
    throw new ActionError(400, (e as Error).message);
  }
  return start({ kind: "website", product: slug, url: url.href }, async (job) => {
    const draft = await draftFromWebsite(url.href, (step) => {
      job.step = step;
    });
    const account = getXAccount(slug);
    if (!account) throw new Error(`${slug} was deleted while reading its website`);
    job.step = "Saving the account";
    try {
      writeProduct(slug, completeDraft(draft, account));
    } catch (e) {
      if (e instanceof ProductWriteError) throw new Error(`Could not build the account from this website: ${e.message}`);
      throw e;
    }
    if (account.avatar_path && fs.existsSync(account.avatar_path)) {
      const dest = path.join(productDir(slug), "assets", path.basename(account.avatar_path));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(account.avatar_path, dest);
      saveXAccount({ ...account, avatar_path: dest });
    }
    fs.rmSync(stagingDir(slug), { recursive: true, force: true });
    logEvent("product_created", { product: slug, payload: { url: url.href } });
    job.step = "Planning posts";
    await planSlots(2).catch((e) => log.warn({ product: slug, err: (e as Error).message }, "planning after setup failed"));
    log.info({ product: slug, url: url.href, pages: draft.sources, notes: draft.notes }, "account ready");
  });
}

// ---------- reconnect / delete ----------

/** Log in again for an account whose session broke. It must be the same X account. */
export function startReconnect(slug: string): AccountJob {
  requireAccount(slug);
  if (runningFor(slug)) throw new ActionError(409, `${slug} is busy; finish what is running first`);
  const before = getXAccount(slug);
  return start({ kind: "reconnect", product: slug, url: null }, async (job) => {
    job.step = "Log in to X in the window that opened";
    const avatarDir = hasProduct(slug) ? path.join(productDir(slug), "assets") : stagingDir(slug);
    const account = await connectWithBrowser(slug, { avatarDir });
    if (before && account.handle.toLowerCase() !== before.handle.toLowerCase()) {
      const error = `logged in as @${account.handle}, but this account is @${before.handle}: reconnect as @${before.handle}`;
      saveXAccount({ ...before, error });
      throw new Error(error);
    }
  });
}

/** Delete an account: product folder, X session, staged avatar, generated files and every row about it. */
export async function deleteAccount(slug: string): Promise<void> {
  requireAccount(slug);
  if (runningFor(slug)) throw new ActionError(409, `${slug} is busy; try again when it finishes`);
  if (currentTick()) throw new ActionError(409, "the scheduler is writing or publishing right now; try again in a minute");
  await disconnectX(slug);
  for (const dir of [productDir(slug), stagingDir(slug), path.join(OUT_DIR, slug)]) fs.rmSync(dir, { recursive: true, force: true });
  deleteProductData(slug);
  logEvent("account_deleted", { product: slug });
  log.info({ product: slug }, "account deleted");
}

// ---------- avatar ----------

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

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

/** The account's avatar, only if it is an image inside products/<slug>/ or data/accounts/<slug>/. */
export function avatarFile(slug: string, account: XAccount | null = SLUG_RE.test(slug) ? getXAccount(slug) : null): string | null {
  if (!account?.avatar_path || !SLUG_RE.test(slug) || !IMAGE_EXT.has(path.extname(account.avatar_path).toLowerCase())) return null;
  return within(path.join(PRODUCTS_DIR, slug), account.avatar_path) ?? within(stagingDir(slug), account.avatar_path);
}
