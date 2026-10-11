// autocm dashboard: vanilla JS, no build step.
import { createAccounts, loadSelected, pickSelected } from "/account.js";

const REFRESH_MS = 15_000;
const FAST_REFRESH_MS = 3_000;

const $ = (sel) => document.querySelector(sel);
const state = { data: null, busy: new Set(), products: new Map(), selected: loadSelected() };
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const LOCALE = "en-GB"; // the UI copy is English; keep dates in English too

// ---------- formatting ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Tweet text: escaped, links / mentions / hashtags coloured like X, line breaks kept by CSS. */
function tweetHtml(text) {
  const re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])|(^|[^\w])(@\w{1,15})|(^|[^\w&])(#[\p{L}\p{N}_]+)/gu;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    if (m[1]) {
      const shown = m[1].replace(/^https?:\/\/(www\.)?/, "");
      out += `<a href="${esc(m[1])}" target="_blank" rel="noopener noreferrer">${esc(shown.length > 30 ? shown.slice(0, 29) + "…" : shown)}</a>`;
    } else if (m[3]) {
      out += esc(m[2]) + `<span class="tw-link">${esc(m[3])}</span>`;
    } else {
      out += esc(m[4]) + `<span class="tw-link">${esc(m[5])}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function fmtTime(iso, tz, withDay = true) {
  const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz };
  if (withDay) Object.assign(opts, { weekday: "short", day: "numeric", month: "short" });
  return new Intl.DateTimeFormat(LOCALE, opts).format(new Date(iso));
}

function tzAbbr(iso, tz) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName");
  return part ? part.value : tz;
}

function dayLabel(iso, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const d = fmt.format(new Date(iso));
  const today = fmt.format(new Date());
  const tomorrow = fmt.format(new Date(Date.now() + 86_400_000));
  if (d === today) return "Today";
  if (d === tomorrow) return "Tomorrow";
  return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: "long", day: "numeric", month: "short" }).format(new Date(iso));
}

function duration(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} days`;
}

function countdown(iso) {
  const ms = Date.parse(iso) - Date.now();
  return ms >= 0 ? `in ${duration(ms)}` : `${duration(ms)} ago`;
}

// ---------- api ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.classList.add("out"), kind === "error" ? 9000 : 4500);
  setTimeout(() => el.remove(), kind === "error" ? 9400 : 4900);
}

// ---------- pieces ----------

const accounts = createAccounts({ $, esc, api: (...a) => api(...a), toast: (...a) => toast(...a), refresh: () => refresh(), state });

function product(slug) {
  return state.products.get(slug) ?? { slug, name: slug, handle: null, timezone: "UTC", color: "#8b95a3" };
}

function mediaHtml(post) {
  if (!post.media.length) return "";
  const items = post.media
    .map((m) => {
      const ratio = m.width && m.height ? `${m.width} / ${m.height}` : "16 / 9";
      if (m.mime.startsWith("video/")) {
        return `<video class="tw-media" controls preload="metadata" playsinline style="aspect-ratio:${ratio}" ${m.poster ? `poster="${esc(m.poster)}"` : ""} src="${esc(m.url)}" aria-label="${esc(post.alt_text || "video")}"></video>`;
      }
      return `<a href="${esc(m.url)}" target="_blank" rel="noopener"><img class="tw-media" loading="lazy" style="aspect-ratio:${ratio}" src="${esc(m.url)}" alt="${esc(post.alt_text || "")}"></a>`;
    })
    .join("");
  return `<div class="tw-media-wrap">${items}</div>`;
}

/** `when`: the scheduled time label shown after the handle. */
function tweetCard(post, when) {
  const p = product(post.product);
  const handle = p.handle ? `@${p.handle}` : `@${p.slug}`;
  const text = post.text ? `<div class="tw-text">${tweetHtml(post.text)}</div>` : `<div class="tw-text tw-empty">No text yet.</div>`;
  return `<article class="tw" aria-label="Post preview">
    ${accounts.avatarHtml(p, "tw-avatar")}
    <div class="tw-body">
      <div class="tw-head"><span class="tw-name">${esc(p.name)}</span><span class="tw-handle">${esc(handle)} · ${esc(when)}</span></div>
      ${text}
      ${mediaHtml(post)}
    </div>
  </article>`;
}

const FORMAT_NAMES = { text: "Text", image: "Image", video: "Video" };
const KIND_NAMES = { none: "no media", template: "branded template", ai_image: "AI image", remotion: "kinetic video", clip: "product clip", ai_video: "AI video" };

function metaHtml(post) {
  const rows = [];
  const fmt = post.format ? `${FORMAT_NAMES[post.format] ?? post.format}${post.media_kind ? `, ${KIND_NAMES[post.media_kind] ?? post.media_kind}` : ""}` : "";
  if (fmt) rows.push(["Format", fmt + (post.fallback_from ? ` (fell back from ${KIND_NAMES[post.fallback_from] ?? post.fallback_from})` : "")]);
  if (post.pillar) rows.push(["Pillar", post.pillar]);
  if (post.weighted_length != null) rows.push(["Length", `${post.weighted_length} of 280`]);
  const dl = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  return `<dl class="facts">${dl}</dl>
    ${post.angle ? `<p class="angle">${esc(post.angle)}</p>` : ""}
    ${post.rationale ? `<p class="rationale"><span>Why now</span>${esc(post.rationale)}</p>` : ""}
    ${post.error && post.status === "approved" ? `<p class="warn">${esc(post.error.startsWith("guard: ") ? `Last publish attempt blocked: ${post.error.slice(7)}` : post.error)}</p>` : ""}`;
}

function btn(action, label, id, opts = {}) {
  const key = `${action}:${id}`;
  const busy = state.busy.has(key);
  return `<button type="button" class="btn ${opts.cls ?? ""}" data-action="${action}" data-id="${id}" ${busy ? "disabled" : ""}>${busy ? opts.busyLabel ?? "Working…" : label}</button>`;
}

const SLOT_STATUS = {
  pending: ["Queued", "neutral"],
  claimed: ["Writing", "busy"],
  generated: ["Will publish", "go"],
};

function slotHtml(slot) {
  const p = product(slot.product);
  const post = slot.post;
  let [statusLabel, tone] = SLOT_STATUS[slot.status];
  if (slot.status === "generated" && p.paused) [statusLabel, tone] = ["On hold: paused", "neutral"];
  const sameTz = p.timezone === localTz;
  const late = Date.parse(slot.scheduled_at) < Date.now();

  let body;
  if (slot.status === "pending") {
    body = p.paused
      ? `<div class="placeholder"><p class="muted">Publishing is paused for ${esc(p.name)}, so the bot is not writing this post yet.</p></div>`
      : `<div class="placeholder"><p class="muted">The bot writes this post on its next pass (every 5 min).</p></div>`;
  } else if (slot.status === "claimed") {
    const since = slot.claimed_at;
    body = `<div class="placeholder writing"><span class="spinner" aria-hidden="true"></span><p>Writing the post${since ? ` <span class="muted" data-since="${esc(since)}"></span>` : ""}. This takes 20 s to 3 min.</p></div>`;
  } else if (post) {
    body = tweetCard(post, fmtTime(slot.scheduled_at, p.timezone, false));
  } else {
    body = `<div class="placeholder"><p class="muted">No post for this slot.</p></div>`;
  }

  let note = "";
  if (slot.status === "generated" && late) note = `<p class="warn">Past its time. The scheduler retries every 5 min${post?.error ? `: ${esc(post.error)}` : ""}.</p>`;
  const actions = slot.status === "generated" && post ? btn("discard", "Discard", post.id, { cls: "btn-danger", busyLabel: "Discarding…" }) : "";

  const soon = !late && Date.parse(slot.scheduled_at) - Date.now() < 3_600_000 && slot.status === "generated";
  return `<li class="slot tone-${tone}${soon ? " soon" : ""}" data-key="slot-${slot.id}">
    <div class="when">
      <div class="when-time">${esc(fmtTime(slot.scheduled_at, p.timezone, false))}</div>
      <div class="when-tz">${esc(tzAbbr(slot.scheduled_at, p.timezone))} · ${esc(dayLabel(slot.scheduled_at, p.timezone))}</div>
      ${sameTz ? "" : `<div class="when-local">${esc(fmtTime(slot.scheduled_at, localTz, false))} your time</div>`}
      <div class="when-count" data-countdown="${esc(slot.scheduled_at)}"></div>
    </div>
    <div class="slot-main">${body}</div>
    <aside class="slot-side">
      <div class="slot-head"><span class="pill pill-${tone}">${esc(statusLabel)}</span><span class="muted small">${esc(p.name)} · slot ${slot.id}</span></div>
      ${post && slot.status !== "claimed" ? metaHtml(post) : ""}
      ${note}
      ${actions ? `<div class="actions">${actions}</div>` : ""}
    </aside>
  </li>`;
}

// ---------- keyed rendering (keeps playing videos alive across refreshes) ----------

function reconcile(container, items, keyOf, html) {
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  const keep = new Set();
  items.forEach((item, i) => {
    const key = keyOf(item);
    keep.add(key);
    const markup = html(item);
    let el = existing.get(key);
    if (!el || el.dataset.sig !== markup) {
      const tpl = document.createElement("template");
      tpl.innerHTML = markup.trim();
      const fresh = tpl.content.firstElementChild;
      fresh.dataset.sig = markup;
      // Keep a video that is playing or was scrubbed if the media did not change.
      if (el) {
        const oldVid = el.querySelector("video");
        const newVid = fresh.querySelector("video");
        if (oldVid && newVid && oldVid.getAttribute("src") === newVid.getAttribute("src")) newVid.replaceWith(oldVid);
        el.replaceWith(fresh);
      }
      el = fresh;
    }
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null);
  });
  for (const [key, el] of existing) if (!keep.has(key)) el.remove();
}

// ---------- render ----------

/** The selected account once it is set up and loads; pause, status and quotas only exist for it. */
function readyAccount() {
  const p = state.products.get(state.selected);
  return p && p.setup === "ready" && !p.invalid ? p : null;
}

function renderHeader(d) {
  accounts.renderSelector();
  const p = readyAccount();
  const pb = $("#pause-btn");
  pb.hidden = !p;
  if (!p) {
    $("#status").innerHTML = "";
    $("#quotas").innerHTML = "";
    return;
  }
  const mode = !p.x || p.x.error
    ? `<button type="button" class="pill pill-stop pill-btn" data-open-accounts title="Reconnect from the account menu">X session problem</button>`
    : "";
  const paused = p.paused
    ? `<span class="pill pill-stop">Paused</span>`
    : `<span class="pill pill-go">Publishing on</span>`;
  const running = d.upcoming.filter((s) => s.status === "claimed").length;
  $("#status").innerHTML = `${mode}${paused}${running ? `<span class="pill pill-busy"><span class="spinner sm" aria-hidden="true"></span>${running} writing</span>` : ""}`;
  pb.textContent = p.paused ? "Resume publishing" : "Pause publishing";
  pb.dataset.paused = p.paused ? "1" : "";
  pb.disabled = state.busy.has("pause");

  const pct = p.daily_cap ? Math.min(100, (p.today_count / p.daily_cap) * 100) : 100;
  const live = p.x ? `posting as @${p.x.handle}` : "X session missing";
  $("#quotas").innerHTML = `<div class="quota${p.enabled ? "" : " off"}" title="${esc(p.name)}: ${p.today_count} of ${p.daily_cap} posts today (${esc(p.timezone)}), ${live}">
      <span class="quota-name">${esc(p.name)}</span>
      <span class="meter" aria-hidden="true"><span style="width:${pct}%"></span></span>
      <span class="quota-num">${p.today_count} of ${p.daily_cap} today</span>${p.enabled ? "" : `<span class="muted small">disabled</span>`}
    </div>`;
}

function render() {
  const d = state.data;
  if (!d) return;
  state.products = new Map(d.products.map((p) => [p.slug, p]));
  renderHeader(d);
  accounts.renderSetup();
  const cur = state.products.get(state.selected);
  $("#view-upcoming").hidden = !cur;
  $("#no-accounts").hidden = !!cur;
  if (!cur) return;
  reconcile($("#upcoming"), d.upcoming, (s) => `slot-${s.id}`, slotHtml);
  $("#upcoming-empty").hidden = d.upcoming.length > 0;
  $("#upcoming-empty").textContent = cur.setup === "website"
    ? "Posts are planned as soon as the account has its website."
    : `Nothing planned for ${cur.name}. The scheduler plans each day at 00:05 UTC.`;
  $("#lede-upcoming").textContent = cur.paused
    ? `Publishing is paused for ${cur.name}. Nothing goes out until you resume; posts past their time by more than 3 h are skipped.`
    : "Posts publish automatically at their time unless you discard them.";
  $("#count-upcoming").textContent = d.upcoming.length || "";
  tickClocks();
}

function tickClocks() {
  for (const el of document.querySelectorAll("[data-countdown]")) el.textContent = countdown(el.dataset.countdown);
  for (const el of document.querySelectorAll("[data-since]")) el.textContent = `for ${duration(Date.now() - Date.parse(el.dataset.since))}`;
}

// ---------- refresh loop ----------

let timer = null;
let loading = null;

async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const fetchState = (slug) => api("GET", slug ? `/api/state?product=${encodeURIComponent(slug)}` : "/api/state");
      const sel = state.selected;
      let data = await fetchState(sel);
      if (sel !== state.selected) return; // the account changed while loading; a newer refresh follows
      // Always show one account: the remembered one if it still exists, else the first.
      const want = pickSelected(data.products, sel);
      if (want !== sel) {
        state.selected = want;
        data = await fetchState(want);
        if (want !== state.selected) return;
      }
      const wasRunning = new Set((state.data?.account_jobs ?? []).filter((j) => j.status === "running").map((j) => j.id));
      state.data = data;
      render();
      for (const j of data.account_jobs) if (wasRunning.has(j.id) && j.status !== "running") accounts.jobFinished(j);
      document.body.classList.remove("offline");
    } catch (e) {
      document.body.classList.add("offline");
      console.warn(e);
    } finally {
      loading = null;
      schedule();
    }
  })();
  return loading;
}

function schedule() {
  clearTimeout(timer);
  const fast = (state.data?.upcoming ?? []).some((s) => s.status === "claimed") || (state.data?.account_jobs ?? []).some((j) => j.status === "running");
  timer = setTimeout(refresh, fast ? FAST_REFRESH_MS : REFRESH_MS);
}

// ---------- actions ----------

async function run(key, fn, okMsg) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg, "ok");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    state.busy.delete(key);
    await refresh();
  }
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-action]");
  if (!b) return;
  const id = Number(b.dataset.id);
  const action = b.dataset.action;
  if (action === "discard") {
    if (!confirm(`Discard post #${id}? It will not be published and nothing replaces it.`)) return;
    run(`discard:${id}`, () => api("POST", `/api/posts/${id}/discard`), `Discarded post #${id}.`);
  }
});

$("#pause-btn").addEventListener("click", () => {
  const p = readyAccount();
  if (!p) return;
  const base = `/api/accounts/${encodeURIComponent(p.slug)}`;
  if ($("#pause-btn").dataset.paused === "1") {
    run("pause", () => api("POST", `${base}/resume`), `Publishing resumed for ${p.name}.`);
  } else {
    run("pause", () => api("POST", `${base}/pause`), `Publishing paused for ${p.name}.`);
  }
});

document.addEventListener("click", (ev) => {
  if (!ev.target.closest("[data-open-accounts]")) return;
  ev.stopPropagation();
  $("#acct-btn").click();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
setInterval(tickClocks, 1000);
refresh();
