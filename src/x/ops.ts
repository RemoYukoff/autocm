// Page-level X operations on an open session: compose and send a post, read the profile, read a post's metrics.
// Selectors and operation names come from selectors.ts; JSON shapes from graphql.ts.
import type { BrowserContext, Locator, Page, Response } from "playwright-core";
import { log } from "../core/log.ts";
import type { MediaFile, XMetrics, XProfile } from "../core/types.ts";
import { tweetUrl, XAuthError, XError } from "../publish/x.ts";
import { hasAuthCookie } from "./browser.ts";
import { findUser, findViewer, parseCreateTweet, parseTweetMetrics } from "./graphql.ts";
import { AUTH_COOKIE, AUTH_WALL_PATHS, GRAPHQL_URL, PATHS, SEL, WAIT } from "./selectors.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function xUrl(origin: string, p: string): string {
  return origin.replace(/\/+$/, "") + p;
}

// ---------- GraphQL tap ----------

export interface TappedResponse {
  json: unknown;
  url: string;
  method: string;
  status: number;
}

/** Every JSON GraphQL response the page receives, buffered so a reader can also see ones that already arrived. */
export class GraphqlTap {
  private buffer: TappedResponse[] = [];
  private waiters = new Set<() => void>();
  private readonly onResponse = (r: Response) => void this.capture(r);

  constructor(private readonly page: Page) {
    page.on("response", this.onResponse);
  }

  private async capture(r: Response): Promise<void> {
    if (!GRAPHQL_URL.test(r.url())) return;
    if (!(r.headers()["content-type"] ?? "").includes("json")) return;
    let json: unknown;
    try {
      json = JSON.parse(await r.text());
    } catch {
      return;
    }
    this.buffer.push({ json, url: r.url(), method: r.request().method(), status: r.status() });
    if (this.buffer.length > 300) this.buffer.splice(0, this.buffer.length - 300);
    for (const w of [...this.waiters]) w();
  }

  /** Forget responses seen so far (call right before the action whose response you want). */
  clear(): void {
    this.buffer = [];
  }

  /** First buffered or future response for which `pick` returns non-null; rejects after `timeoutMs`. */
  next<T>(pick: (r: TappedResponse) => T | null, timeoutMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let seen = 0;
      const check = () => {
        if (done) return;
        for (; seen < this.buffer.length; seen++) {
          const v = pick(this.buffer[seen]!);
          if (v !== null) return finish(() => resolve(v));
        }
      };
      const onClose = () => finish(() => reject(new Error(`page closed while waiting for ${what}`)));
      const timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`))), timeoutMs);
      const waiter = () => {
        // clear() or trimming shrank the buffer: start over on what is there
        if (seen > this.buffer.length) seen = 0;
        check();
      };
      const finish = (f: () => void) => {
        done = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        this.page.off("close", onClose);
        f();
      };
      this.page.once("close", onClose);
      this.waiters.add(waiter);
      check();
    });
  }

  /** Latest buffered response for which `pick` returns non-null (no waiting). */
  latest<T>(pick: (r: TappedResponse) => T | null): T | null {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const v = pick(this.buffer[i]!);
      if (v !== null) return v;
    }
    return null;
  }

  stop(): void {
    this.page.off("response", this.onResponse);
    this.waiters.clear();
  }
}

// ---------- session checks ----------

const LOGGED_OUT = "X session is logged out, locked or challenged: reconnect the account from the dashboard";

/** Throw XAuthError when the profile has no X session cookie (checked before loading anything). */
export async function requireAuthCookie(ctx: BrowserContext, origin: string): Promise<void> {
  if (!(await hasAuthCookie(ctx, origin, AUTH_COOKIE))) throw new XAuthError(`${LOGGED_OUT} (no session cookie)`);
}

/** Throw XAuthError when the page landed on a login wall / lock screen. */
export function assertNotWalled(page: Page): void {
  let pathname = "";
  try {
    pathname = new URL(page.url()).pathname;
  } catch {
    return;
  }
  if (AUTH_WALL_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`)))
    throw new XAuthError(`${LOGGED_OUT} (redirected to ${pathname})`);
}

async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: WAIT.navigation });
  assertNotWalled(page);
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

// ---------- compose ----------

/** Whitespace-insensitive comparison of what is in the composer with what we meant to post. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[​﻿]/g, "").replace(/\s+/g, " ").trim().normalize("NFC");
  return norm(a) === norm(b);
}

async function clearBox(page: Page, box: Locator): Promise<void> {
  await box.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
}

/**
 * Put `text` into the composer. First a synthetic paste (Draft.js keeps newlines and emoji, and no
 * mention/hashtag typeahead opens), then line-by-line typing as a fallback. Verified against the result.
 */
async function fillComposer(page: Page, box: Locator, text: string): Promise<void> {
  if ((await box.innerText()).trim()) await clearBox(page, box);
  await box.click();
  await box.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await sleep(300);
  if (sameText(await box.innerText(), text)) return;

  log.warn("x: paste into the composer did not take, typing instead");
  await clearBox(page, box);
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line) await page.keyboard.insertText(line);
    if (i < lines.length - 1) await page.keyboard.press("Enter");
  }
  await sleep(300);
  const got = await box.innerText();
  if (!sameText(got, text)) throw new Error(`composer text does not match the post (expected ${text.length} chars, got ${got.length})`);
}

async function isEnabled(button: Locator): Promise<boolean> {
  return button
    .evaluate((el) => el.getAttribute("aria-disabled") !== "true" && !(el as HTMLButtonElement).disabled)
    .catch(() => false);
}

/** Best-effort alt text for attached images: open the media editor, type, save. Never throws. */
async function setAltText(page: Page, altText: string, images: number): Promise<void> {
  const text = altText.slice(0, 1000);
  for (let i = 0; i < images; i++) {
    try {
      const open = page.locator(SEL.altTextOpen).nth(i);
      await open.click({ timeout: 10_000 });
      const input = page.locator(SEL.altTextInput).first();
      await input.waitFor({ state: "visible", timeout: 10_000 });
      await input.fill(text);
      await page.locator(SEL.altTextSave).first().click({ timeout: 10_000 });
      await input.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    } catch (e) {
      log.warn({ image: i, err: (e as Error).message.split("\n")[0] }, "x: could not set alt text (posting without it)");
      return;
    }
  }
}

/** Where the composer lives: the compose modal when there is one, else the page. */
type Scope = Pick<Page, "locator">;

async function attachMedia(page: Page, scope: Scope, media: MediaFile[], altText: string | null | undefined): Promise<void> {
  const input = scope.locator(SEL.fileInput).first();
  await input.waitFor({ state: "attached", timeout: WAIT.composer });
  await input.setInputFiles(media.map((m) => m.path));
  await scope.locator(SEL.attachment).first().waitFor({ state: "attached", timeout: 60_000 });

  const images = media.filter((m) => m.mime.startsWith("image/")).length;
  if (altText && images) await setAltText(page, altText, images);

  // Upload and (for video) server-side processing: the Post button stays disabled and a progress bar shows.
  const hasVideo = media.some((m) => m.mime.startsWith("video/"));
  const deadline = Date.now() + (hasVideo ? WAIT.videoUpload : WAIT.imageUpload);
  const button = scope.locator(SEL.postButton).first();
  let readyStreak = 0;
  while (Date.now() < deadline) {
    const uploading = (await scope.locator(SEL.uploadProgress).count().catch(() => 0)) > 0;
    readyStreak = !uploading && (await isEnabled(button)) ? readyStreak + 1 : 0;
    if (readyStreak >= 2) return;
    await sleep(1000);
  }
  const toast = await page.locator(SEL.toast).first().innerText({ timeout: 1000 }).catch(() => "");
  throw new Error(`media upload did not finish within ${Math.round((hasVideo ? WAIT.videoUpload : WAIT.imageUpload) / 1000)}s${toast ? ` (X says: ${toast.slice(0, 200)})` : ""}`);
}

const decided = new WeakSet<Error>();

/**
 * Compose and send one post. Before the Post click every failure is transient (nothing was sent). After it,
 * only X's answer to the post request decides; without one the outcome is unknown.
 */
export async function composeAndPost(
  ctx: BrowserContext,
  page: Page,
  tap: GraphqlTap,
  origin: string,
  input: { text: string; media: MediaFile[]; altText?: string | null; handle: string | null },
): Promise<{ id: string; url: string }> {
  let clicked = false;
  try {
    await requireAuthCookie(ctx, origin);
    await goto(page, xUrl(origin, PATHS.compose));
    try {
      await page.locator(SEL.composerText).first().waitFor({ state: "visible", timeout: WAIT.composer });
    } catch {
      assertNotWalled(page);
      if (await isVisible(page, SEL.loggedOutMarker)) throw new XAuthError(`${LOGGED_OUT} (login prompt shown)`);
      throw new Error("the composer did not appear");
    }
    // /compose/post opens a modal over the home timeline, whose inline composer sits behind it: stay inside the modal.
    const modal = page.locator(SEL.composeModal).filter({ has: page.locator(SEL.composerText) }).last();
    const scope: Scope = (await modal.count()) > 0 ? modal : page;
    const box = scope.locator(SEL.composerText).first();
    await fillComposer(page, box, input.text);
    if (input.media.length) await attachMedia(page, scope, input.media, input.altText);

    const button = scope.locator(SEL.postButton).first();
    const deadline = Date.now() + 15_000;
    while (!(await isEnabled(button))) {
      if (Date.now() > deadline) throw new Error("the Post button stayed disabled");
      await sleep(500);
    }

    tap.clear();
    const created = tap.next((r) => parseCreateTweet(r.json, r.url, r.method), WAIT.createTweet, "X to confirm the post");
    created.catch(() => undefined); // handled below; avoid an unhandled rejection if the click throws
    clicked = true;
    await button.click({ timeout: 10_000 });
    const res = await created;
    if (!res.ok) {
      const err = res.error.kind === "auth" ? new XAuthError(res.error.message) : new XError(res.error.message, res.error.kind);
      decided.add(err);
      throw err;
    }
    const handle = res.handle ?? input.handle;
    return { id: res.id, url: tweetUrl(res.id, handle ?? undefined) };
  } catch (e) {
    const msg = (e as Error)?.message?.split("\n")[0] ?? String(e);
    if (!clicked) {
      if (e instanceof XError) throw e;
      throw new XError(`X post: ${msg} (failed before clicking Post: nothing was sent)`, "transient", e);
    }
    if (e instanceof XError && decided.has(e)) throw e;
    throw new XError(
      `X post: clicked Post but X did not confirm it (${msg}). The outcome is unknown: check the account on X before posting this again`,
      "permanent",
      e,
    );
  }
}

// ---------- profile ----------

/** Logged-in account: handle from the side nav (or a viewer response), name and avatar from X's user JSON or the DOM. */
export async function readProfile(ctx: BrowserContext, page: Page, tap: GraphqlTap, origin: string): Promise<XProfile> {
  await requireAuthCookie(ctx, origin);
  tap.clear();
  await goto(page, xUrl(origin, PATHS.home));
  const marker = await page
    .locator(SEL.loggedInMarker)
    .first()
    .waitFor({ state: "attached", timeout: WAIT.profile })
    .then(() => true)
    .catch(() => false);
  assertNotWalled(page);

  let handle: string | null = null;
  if (marker) {
    const href = await page.locator(SEL.profileLink).first().getAttribute("href", { timeout: 2000 }).catch(() => null);
    handle = href?.replace(/^.*\//, "").replace(/[?#].*$/, "") || null;
  }
  const viewer = tap.latest((r) => findViewer(r.json));
  handle ??= viewer?.handle ?? null;
  if (!handle) {
    if (await isVisible(page, SEL.loggedOutMarker)) throw new XAuthError(`${LOGGED_OUT} (login prompt shown)`);
    throw new XError("could not find the logged-in X handle on the home page", "transient");
  }

  const known = tap.latest((r) => findUser(r.json, handle!));
  if (known?.name && known.avatar_url) return known;

  tap.clear();
  await goto(page, xUrl(origin, PATHS.profile(handle)));
  const fromJson = await tap.next((r) => findUser(r.json, handle!), WAIT.profile, `the profile of @${handle}`).catch(() => null);
  if (fromJson) return fromJson;

  // DOM fallback.
  const name = (await page.locator(SEL.profileName).first().innerText({ timeout: 5000 }).catch(() => "")).split("\n")[0]?.trim() || null;
  const avatar = await page.locator(SEL.avatarImg).first().getAttribute("src", { timeout: 5000 }).catch(() => null);
  return { handle, name: name ?? known?.name ?? null, avatar_url: avatar ?? known?.avatar_url ?? null };
}

// ---------- metrics ----------

/** Engagement counts of post `id`, read from the post page's TweetDetail-like response. */
export async function readMetrics(page: Page, tap: GraphqlTap, origin: string, handle: string | null, id: string): Promise<XMetrics> {
  tap.clear();
  await goto(page, xUrl(origin, PATHS.status(handle ?? "i/web", id)));
  try {
    return await tap.next((r) => parseTweetMetrics(r.json, id), WAIT.metrics, `metrics of post ${id}`);
  } catch (e) {
    assertNotWalled(page);
    if (await isVisible(page, SEL.loggedOutMarker)) throw new XAuthError(`${LOGGED_OUT} (login prompt shown)`);
    throw new XError(`X metrics for ${id}: ${(e as Error).message}`, "transient", e);
  }
}
