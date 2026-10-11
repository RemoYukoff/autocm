// autocm dashboard: vanilla JS, no build step.
import { createAccounts, loadSelected, pickSelected } from "/account.js";

const REFRESH_MS = 15_000;
const FAST_REFRESH_MS = 3_000;

const $ = (sel) => document.querySelector(sel);
// `day`: the "YYYY-MM-DD" shown (account timezone), null = today. `cal`: the month ("YYYY-MM") the open calendar shows.
const state = { data: null, busy: new Set(), products: new Map(), selected: loadSelected(), editing: null, day: null, cal: null };
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

/** "YYYY-MM-DDTHH:MM" wall time of `iso` in `tz` (split into the date and time inputs). */
function localInput(iso, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
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

// Calendar dates are "YYYY-MM-DD" strings in the account's timezone; do their arithmetic in UTC.
const DAY_MS = 86_400_000;
const dateMs = (date) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date, n) => new Date(dateMs(date) + n * DAY_MS).toISOString().slice(0, 10);
const fmtDate = (date, opts) => new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", ...opts }).format(new Date(dateMs(date) + DAY_MS / 2));

/** "Today" / "Yesterday" / "Tomorrow" / "Saturday 10 Oct". */
function dateLabel(date, today) {
  const diff = Math.round((dateMs(date) - dateMs(today)) / DAY_MS);
  if (Math.abs(diff) <= 1) return ["Yesterday", "Today", "Tomorrow"][diff + 1];
  return fmtDate(date, { weekday: "long", day: "numeric", month: "short" });
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

/** In-page confirmation (replaces window.confirm). Resolves true on the OK button; Cancel, Escape or a click outside is false. */
function ask({ title, body = "", ok = "OK", danger = false }) {
  const d = $("#confirm");
  if (d.open) d.close();
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-body").hidden = !body;
  const b = $("#confirm-ok");
  b.textContent = ok;
  b.className = `btn ${danger ? "btn-danger-solid" : "btn-primary"}`;
  d.returnValue = "";
  d.showModal();
  b.focus();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

// ---------- lightbox: an image shown large over a dimmed page; a click outside it (or Escape) closes ----------

document.addEventListener("click", (ev) => {
  const open = ev.target.closest("[data-lightbox]");
  if (!open) return;
  const img = $("#lightbox-img");
  img.src = open.dataset.lightbox;
  img.alt = open.querySelector("img")?.alt ?? "";
  $("#lightbox").showModal();
});
$("#lightbox").addEventListener("click", (ev) => {
  if (ev.target !== $("#lightbox-img")) $("#lightbox").close();
});
$("#lightbox").addEventListener("close", () => $("#lightbox-img").removeAttribute("src"));

$("#confirm").addEventListener("click", (ev) => {
  if (ev.target === ev.currentTarget) ev.currentTarget.close(); // the backdrop
});

// ---------- pieces ----------

const accounts = createAccounts({ $, esc, api: (...a) => api(...a), toast: (...a) => toast(...a), refresh: () => refresh(), state, ask });

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
      return `<button type="button" class="tw-media-open" data-lightbox="${esc(m.url)}" aria-label="View image larger"><img class="tw-media" loading="lazy" style="aspect-ratio:${ratio}" src="${esc(m.url)}" alt="${esc(post.alt_text || "")}"></button>`;
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

function btn(action, label, id, opts = {}) {
  const key = `${action}:${id}`;
  const busy = state.busy.has(key);
  return `<button type="${opts.type ?? "button"}" class="btn ${opts.cls ?? ""}" data-action="${action}" data-id="${id}" ${busy ? "disabled" : ""}>${busy ? opts.busyLabel ?? "Working…" : label}</button>`;
}

/** Colour of the timeline dot. */
const SLOT_TONE = { pending: "neutral", claimed: "busy", generated: "go", done: "go", skipped: "off", failed: "stop" };
const UPCOMING = new Set(["pending", "claimed", "generated"]);

/** What happened to a slot that is over: the line under its time. */
function outcomeHtml(slot) {
  const post = slot.post;
  if (slot.status === "done") {
    return post?.url
      ? `<a class="when-out out-done" href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">Published ↗</a>`
      : `<div class="when-out out-done">Published</div>`;
  }
  if (slot.status === "failed") return `<div class="when-out out-failed">Failed</div>`;
  return `<div class="when-out" title="${esc(post?.error ?? "")}">Not published</div>`;
}

function historyHtml(slot) {
  const p = product(slot.product);
  const post = slot.post;
  const sameTz = p.timezone === localTz;
  const err = slot.status === "failed" && post?.error ? `<p class="warn">${esc(post.error)}</p>` : "";
  const body = post?.text || post?.media.length
    ? tweetCard(post, fmtTime(slot.scheduled_at, p.timezone, false))
    : `<div class="placeholder"><p class="muted">Never written.</p></div>`;
  return `<li class="slot tone-${SLOT_TONE[slot.status]}${slot.status === "done" ? "" : " dropped"}" data-key="slot-${slot.id}">
    <div class="when">
      <div class="when-time">${esc(fmtTime(slot.scheduled_at, p.timezone, false))}</div>
      <div class="when-tz">${esc(tzAbbr(slot.scheduled_at, p.timezone))}</div>
      ${sameTz ? "" : `<div class="when-local">${esc(fmtTime(slot.scheduled_at, localTz, false))} your time</div>`}
      ${outcomeHtml(slot)}
    </div>
    <div class="slot-main">${err}${body}</div>
  </li>`;
}

function slotHtml(slot) {
  if (!UPCOMING.has(slot.status)) return historyHtml(slot);
  const p = product(slot.product);
  const post = slot.post;
  const tone = SLOT_TONE[slot.status];
  const sameTz = p.timezone === localTz;
  const late = Date.parse(slot.scheduled_at) < Date.now();

  let body;
  if (slot.status === "pending" || slot.status === "claimed") {
    const since = slot.status === "claimed" ? slot.claimed_at : null;
    body = `<div class="placeholder writing"><span class="spinner" aria-hidden="true"></span><p>Generating…${since ? ` <span class="muted" data-since="${esc(since)}"></span>` : ""}</p></div>`;
  } else if (post) {
    body = tweetCard(post, fmtTime(slot.scheduled_at, p.timezone, false));
  } else {
    body = `<div class="placeholder"><p class="muted">No post for this slot.</p></div>`;
  }

  const discard = slot.status === "generated" && post ? btn("discard", "Discard", post.id, { cls: "btn-danger btn-sm", busyLabel: "Discarding…" }) : "";

  const soon = !late && Date.parse(slot.scheduled_at) - Date.now() < 3_600_000 && slot.status === "generated";
  // This slot has not published yet, so its time can change. The input holds no live value in the markup,
  // so the 15 s refresh does not replace the form while it is being edited.
  const time = state.editing === slot.id
    ? `<form class="time-form" data-time-form="${slot.id}">
        <input type="time" name="time" required value="${esc(localInput(slot.scheduled_at, p.timezone).slice(11))}" aria-label="New time (${esc(p.timezone)})">
        <input type="date" name="date" required value="${esc(localInput(slot.scheduled_at, p.timezone).slice(0, 10))}" aria-label="Day">
        <div class="time-form-row">${btn("save-time", "Save", slot.id, { cls: "btn-primary btn-sm", busyLabel: "Saving…", type: "submit" })}<button type="button" class="btn btn-sm" data-action="cancel-time" data-id="${slot.id}">Cancel</button></div>
      </form>`
    : `<button type="button" class="when-time" data-action="edit-time" data-id="${slot.id}" title="Change the time">${esc(fmtTime(slot.scheduled_at, p.timezone, false))}</button>`;
  return `<li class="slot tone-${tone}${soon ? " soon" : ""}" data-key="slot-${slot.id}">
    <div class="when">
      ${time}
      <div class="when-tz">${esc(tzAbbr(slot.scheduled_at, p.timezone))} · ${esc(dayLabel(slot.scheduled_at, p.timezone))}</div>
      ${sameTz ? "" : `<div class="when-local">${esc(fmtTime(slot.scheduled_at, localTz, false))} your time</div>`}
      <div class="when-count" data-countdown="${esc(slot.scheduled_at)}"></div>
      ${discard}
    </div>
    <div class="slot-main">${body}</div>
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

/** The selected account once it is set up and loads; pause, status and Generate only exist for it. */
function readyAccount() {
  const p = state.products.get(state.selected);
  return p && p.setup === "ready" && !p.invalid ? p : null;
}

function renderHeader(d) {
  accounts.renderSelector();
  const p = readyAccount();
  const pb = $("#pause-btn");
  pb.hidden = !p;
  const gb = $("#gen-btn");
  gb.hidden = !p;
  gb.disabled = state.busy.has("generate");
  gb.textContent = gb.disabled ? "Adding…" : "+ Generate post";
  if (!p) {
    $("#status").innerHTML = "";
    return;
  }
  const mode = !p.x || p.x.error
    ? `<button type="button" class="pill pill-stop pill-btn" data-open-accounts title="Reconnect from the account menu">X session problem</button>`
    : "";
  $("#status").innerHTML = `${mode}${d.writing ? `<span class="pill pill-busy"><span class="spinner sm" aria-hidden="true"></span>${d.writing} writing</span>` : ""}`;
  const label = p.paused ? `Resume publishing for ${p.name}` : `Pause publishing for ${p.name}`;
  pb.innerHTML = p.paused
    ? `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z"/></svg>`
    : `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx=".8"/><rect x="9.4" y="3" width="2.6" height="10" rx=".8"/></svg>`;
  pb.title = label;
  pb.setAttribute("aria-label", label);
  pb.classList.toggle("paused", !!p.paused);
  pb.dataset.paused = p.paused ? "1" : "";
  pb.disabled = state.busy.has("pause");
}

/** One dot per post of the day (capped), coloured by what happened to it. */
function dayMarks(d) {
  const dots = [...Array(d.published).fill("done"), ...Array(d.upcoming).fill("up"), ...Array(d.dropped).fill("drop")].slice(0, 5);
  return dots.map((k) => `<i class="mk-${k}"></i>`).join("");
}

function dayTitle(d) {
  const parts = [];
  if (d.published) parts.push(`${d.published} published`);
  if (d.upcoming) parts.push(`${d.upcoming} to publish`);
  if (d.dropped) parts.push(`${d.dropped} not published`);
  return parts.join(" · ") || "No posts";
}

/** Days in the strip: the past week through today. Older days are in the calendar. */
const WEEK = 7;
const NO_POSTS = { published: 0, upcoming: 0, dropped: 0 };

/** Newest on the left: planned days after today, today, then the six days before it. */
function stripDates(d) {
  const future = d.days.filter((x) => x.date > d.today).map((x) => x.date);
  return [...future, ...Array.from({ length: WEEK }, (_, i) => addDays(d.today, -i))];
}

function chipBody(date, today, info) {
  return `<span class="day-wd">${date === today ? "Today" : esc(fmtDate(date, { weekday: "short" }))}</span>
    <span class="day-n">${Number(date.slice(8))}</span>
    <span class="day-mon">${esc(fmtDate(date, { month: "short" }))}</span>
    <span class="day-marks">${dayMarks(info)}</span>`;
}

function calHtml(d, byDate) {
  const shown = d.day.date;
  const oldest = (d.days.at(-1)?.date ?? d.today).slice(0, 7);
  const newest = [d.today, d.days[0]?.date ?? d.today].sort().at(-1).slice(0, 7);
  const month = state.cal;
  const first = `${month}-01`;
  const lead = (new Date(dateMs(first)).getUTCDay() + 6) % 7; // Monday first
  const len = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const cells = Array.from({ length: lead }, () => `<span></span>`);
  for (let n = 1; n <= len; n++) {
    const date = `${month}-${String(n).padStart(2, "0")}`;
    const info = byDate.get(date);
    const cls = `cal-day${date === d.today ? " is-today" : ""}`;
    cells.push(info
      ? `<button type="button" class="${cls}" data-day="${date}" aria-pressed="${date === shown}" title="${esc(`${dateLabel(date, d.today)}: ${dayTitle(info)}`)}"><span>${n}</span><span class="day-marks">${dayMarks(info)}</span></button>`
      : `<span class="${cls} off">${n}</span>`);
  }
  const step = (dir, ok, label) => `<button type="button" class="cal-step" data-cal-step="${dir}" ${ok ? "" : "disabled"} aria-label="${label}">${dir < 0 ? "‹" : "›"}</button>`;
  return `<div class="cal" id="cal" role="dialog" aria-label="Pick a day">
    <div class="cal-head">${step(-1, month > oldest, "Previous month")}<span>${esc(fmtDate(first, { month: "long", year: "numeric" }))}</span>${step(1, month < newest, "Next month")}</div>
    <div class="cal-grid">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((w) => `<span class="cal-wd">${w}</span>`).join("")}${cells.join("")}</div>
  </div>`;
}

function renderDays(d) {
  const nav = $("#days");
  nav.hidden = !d.day || readyAccount() === null;
  if (nav.hidden) return;
  const byDate = new Map(d.days.map((x) => [x.date, x]));
  const shown = d.day.date;
  const dates = stripDates(d);
  const chips = dates
    .map((date) => {
      const info = byDate.get(date) ?? NO_POSTS;
      const empty = !byDate.has(date);
      return `<button type="button" class="day${date === d.today ? " is-today" : ""}${empty ? " is-empty" : ""}" data-day="${date}" aria-pressed="${date === shown}" title="${esc(`${dateLabel(date, d.today)}: ${dayTitle(info)}`)}">${chipBody(date, d.today, info)}</button>`;
    })
    .join("");
  // A day picked in the calendar stays visible on the More button.
  const picked = !dates.includes(shown);
  const more = `<button type="button" class="day day-more" id="cal-btn" aria-haspopup="dialog" aria-expanded="${!!state.cal}" aria-pressed="${picked}" title="Older days">
      ${picked ? chipBody(shown, d.today, byDate.get(shown) ?? NO_POSTS) : `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg><span class="day-wd">More</span>`}
    </button>`;
  const markup = `<div class="days-scroll" id="days-scroll">${chips}</div><div class="days-more">${more}${state.cal ? calHtml(d, byDate) : ""}</div>`;
  if (nav.dataset.sig === markup) return;
  const prev = $("#days-scroll")?.scrollLeft ?? 0;
  nav.innerHTML = markup;
  nav.dataset.sig = markup;
  $("#days-scroll").scrollLeft = prev;
}

function closeCal() {
  if (!state.cal) return;
  state.cal = null;
  render();
}

$("#days").addEventListener("click", (ev) => {
  const stepBtn = ev.target.closest("button[data-cal-step]");
  if (stepBtn) {
    const [y, m] = state.cal.split("-").map(Number);
    state.cal = new Date(Date.UTC(y, m - 1 + Number(stepBtn.dataset.calStep), 1)).toISOString().slice(0, 7);
    render();
    return;
  }
  if (ev.target.closest("#cal-btn")) {
    state.cal = state.cal ? null : state.data.day.date.slice(0, 7);
    render();
    return;
  }
  const b = ev.target.closest("button[data-day]");
  if (!b) return;
  // Today is kept as null so the view follows the date past midnight.
  state.day = b.dataset.day === state.data.today ? null : b.dataset.day;
  state.cal = null;
  state.editing = null;
  render();
  refresh();
});
document.addEventListener("click", (ev) => {
  if (state.cal && !ev.target.closest(".days-more")) closeCal();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.cal) {
    closeCal();
    $("#cal-btn")?.focus();
  }
});

function render() {
  const d = state.data;
  if (!d) return;
  state.products = new Map(d.products.map((p) => [p.slug, p]));
  renderHeader(d);
  accounts.renderSetup();
  const cur = state.products.get(state.selected);
  $("#view-day").hidden = !cur;
  $("#no-accounts").hidden = !!cur;
  if (!cur) return;
  renderDays(d);
  const day = d.day;
  if (!day) return;
  reconcile($("#slots"), day.slots, (s) => `slot-${s.id}`, slotHtml);
  const past = day.date < d.today;
  $("#view-title").textContent = dateLabel(day.date, d.today);
  $("#lede").textContent = past
    ? (day.slots.length ? `${dayTitle(d.days.find((x) => x.date === day.date) ?? NO_POSTS)}.` : "")
    : "Posts publish automatically at their time unless you discard them.";
  $("#lede").hidden = !$("#lede").textContent;
  $("#empty").hidden = day.slots.length > 0;
  $("#empty").textContent = past
    ? "No posts on this day."
    : cur.setup === "website"
      ? "Posts are planned as soon as the account has its website."
      : `Nothing planned for ${cur.name}. The scheduler plans each day at 00:05 UTC.`;
  $("#count").textContent = day.slots.length || "";
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
  let stale = false;
  loading = (async () => {
    try {
      const fetchState = (slug) => {
        if (!slug) return api("GET", "/api/state");
        const day = state.day ? `&day=${state.day}` : "";
        return api("GET", `/api/state?product=${encodeURIComponent(slug)}${day}`);
      };
      const sel = state.selected;
      const selDay = state.day;
      let data = await fetchState(sel);
      if ((stale = sel !== state.selected || selDay !== state.day)) return; // changed while loading: fetch again
      // Always show one account: the remembered one if it still exists, else the first.
      const want = pickSelected(data.products, sel);
      if (want !== sel) {
        state.selected = want;
        data = await fetchState(want);
        if ((stale = want !== state.selected || selDay !== state.day)) return;
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
      if (stale) refresh();
      else schedule();
    }
  })();
  return loading;
}

function schedule() {
  clearTimeout(timer);
  const fast = state.data?.writing > 0 || (state.data?.account_jobs ?? []).some((j) => j.status === "running");
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

document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-action]");
  if (!b) return;
  const id = Number(b.dataset.id);
  const action = b.dataset.action;
  if (action === "discard") {
    if (!(await ask({ title: "Discard this post?", body: "It is deleted with its image or video. There is no going back.", ok: "Discard", danger: true }))) return;
    run(`discard:${id}`, () => api("POST", `/api/posts/${id}/discard`), "Post deleted.");
  } else if (action === "edit-time") {
    state.editing = id;
    render();
    document.querySelector(`[data-time-form="${id}"] input`)?.focus();
  } else if (action === "cancel-time") {
    state.editing = null;
    render();
  }
});

document.addEventListener("submit", (ev) => {
  const form = ev.target.closest("[data-time-form]");
  if (!form) return;
  ev.preventDefault();
  const id = Number(form.dataset.timeForm);
  const f = new FormData(form);
  const at = `${f.get("date")}T${f.get("time")}`;
  run(`save-time:${id}`, async () => {
    await api("POST", `/api/slots/${id}/time`, { at });
    state.editing = null;
  }, "Time changed.");
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.editing !== null && ev.target.closest?.("[data-time-form]")) {
    state.editing = null;
    render();
  }
});

$("#gen-btn").addEventListener("click", () => {
  const p = readyAccount();
  if (!p) return;
  run(
    "generate",
    () => api("POST", `/api/accounts/${encodeURIComponent(p.slug)}/generate`),
    (r) => `New post for ${fmtTime(r.slot.scheduled_at, p.timezone)}. Writing it now.`,
  );
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
