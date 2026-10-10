// autocm dashboard: vanilla JS, no build step.
const REFRESH_MS = 15_000;
const FAST_REFRESH_MS = 3_000;

const $ = (sel) => document.querySelector(sel);
const state = { data: null, history: [], historyTotal: 0, tab: "upcoming", busy: new Set(), products: new Map() };
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

function relative(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" }).format(new Date(iso));
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

/** `when`: a fixed label (scheduled time), or {ago: iso} for an X-style relative time kept fresh by tickClocks. */
function tweetCard(post, when) {
  const p = product(post.product);
  const initial = (p.name || p.slug).trim().charAt(0).toUpperCase();
  const handle = p.handle ? `@${p.handle}` : `@${p.slug}`;
  const text = post.text ? `<div class="tw-text">${tweetHtml(post.text)}</div>` : `<div class="tw-text tw-empty">No text yet.</div>`;
  return `<article class="tw" aria-label="Post preview">
    <div class="tw-avatar" style="--av:${esc(p.color)}" aria-hidden="true">${esc(initial)}</div>
    <div class="tw-body">
      <div class="tw-head"><span class="tw-name">${esc(p.name)}</span><span class="tw-handle">${esc(handle)}${typeof when === "string" ? ` · ${esc(when)}` : when?.ago ? ` · <span data-rel="${esc(when.ago)}"></span>` : ""}</span></div>
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

function formatSelect(id) {
  return `<select class="fmt" data-format-for="${id}" aria-label="Format for the new version">
    <option value="auto">Any format</option><option value="text">Text</option><option value="image">Image</option><option value="video">Video</option>
  </select>`;
}

function jobForSlot(slotId) {
  return (state.data?.jobs ?? []).find((j) => j.slot_id === slotId && j.status === "running");
}

const SLOT_STATUS = {
  pending: ["Not written yet", "neutral"],
  claimed: ["Writing", "busy"],
  generated: ["Will publish", "go"],
  skipped: ["Skipped", "stop"],
  failed: ["Failed", "stop"],
  done: ["Published", "go"],
};

function slotHtml(slot) {
  const p = product(slot.product);
  const post = slot.post;
  let [statusLabel, tone] = SLOT_STATUS[slot.status] ?? [slot.status, "neutral"];
  if (slot.status === "generated" && state.data?.paused) [statusLabel, tone] = ["On hold: paused", "neutral"];
  if (slot.status === "skipped" && post?.error?.includes("vetoed")) statusLabel = "Vetoed";
  const sameTz = p.timezone === localTz;
  const late = Date.parse(slot.scheduled_at) < Date.now();
  const job = jobForSlot(slot.id);

  let body;
  if (slot.status === "pending") {
    body = `<div class="placeholder"><p>Writes itself at <strong>${esc(fmtTime(slot.generate_at, p.timezone, false))} ${esc(tzAbbr(slot.generate_at, p.timezone))}</strong> <span class="muted">(<span data-countdown="${esc(slot.generate_at)}"></span>)</span>.</p><p class="muted">You can write it now to review it earlier, or skip this slot.</p></div>`;
  } else if (slot.status === "claimed") {
    const since = job?.started_at ?? slot.claimed_at;
    body = `<div class="placeholder writing"><span class="spinner" aria-hidden="true"></span><p>Writing the post${since ? ` <span class="muted" data-since="${esc(since)}"></span>` : ""}. This takes 20 s to 3 min.</p></div>`;
  } else if (post) {
    body = tweetCard(post, fmtTime(slot.scheduled_at, p.timezone, false));
  } else {
    body = `<div class="placeholder"><p class="muted">No post for this slot.</p></div>`;
  }

  let note = "";
  if ((slot.status === "skipped" || slot.status === "failed") && post?.error) note = `<p class="${post.error.includes("vetoed") ? "note" : "warn"}">${esc(post.error)}</p>`;
  if (slot.status === "generated" && late) note = `<p class="warn">Past its time. The scheduler retries every 5 min${post?.error ? `: ${esc(post.error)}` : ""}.</p>`;

  let actions = "";
  if (slot.status === "generated" && post) {
    actions = btn("publish", "Publish now", post.id, { cls: "btn-primary", busyLabel: "Publishing…" }) +
      `<span class="regen">${btn("regenerate", "Regenerate", slot.id, { busyLabel: "Starting…" })}${formatSelect(slot.id)}</span>` +
      btn("discard", "Discard", post.id, { cls: "btn-danger", busyLabel: "Discarding…" });
  } else if (slot.status === "pending") {
    actions = `<span class="regen">${btn("regenerate", "Write now", slot.id, { busyLabel: "Starting…" })}${formatSelect(slot.id)}</span>` + btn("skip", "Skip slot", slot.id, { cls: "btn-danger" });
  } else if (slot.status === "skipped" || slot.status === "failed") {
    actions = `<span class="regen">${btn("regenerate", "Write a new post", slot.id, { busyLabel: "Starting…" })}${formatSelect(slot.id)}</span>`;
  }

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

function readyHtml(post) {
  return `<div class="row" data-key="post-${post.id}">
    <div class="row-main">${tweetCard(post, { ago: post.created_at })}</div>
    <aside class="slot-side">
      <div class="slot-head"><span class="pill pill-neutral">Unscheduled</span><span class="muted small">#${post.id} · made <span data-ago="${esc(post.created_at)}"></span></span></div>
      ${metaHtml(post)}
      <div class="actions">${btn("publish", "Publish now", post.id, { cls: "btn-primary", busyLabel: "Publishing…" })}${btn("discard", "Discard", post.id, { cls: "btn-danger", busyLabel: "Discarding…" })}</div>
    </aside>
  </div>`;
}

const HISTORY_STATUS = {
  published: ["Live on X", "go"],
  dry_run: ["Dry run", "neutral"],
  rejected: ["Discarded", "stop"],
  failed: ["Failed", "stop"],
  qa_failed: ["Failed QA", "stop"],
};

function historyHtml(post) {
  const [label, tone] = HISTORY_STATUS[post.status] ?? [post.status, "neutral"];
  const when = post.published_at ?? post.updated_at;
  const link = post.url && post.status === "published" ? `<a class="btn" href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">Open on X</a>` : "";
  const err = post.error && post.status !== "published" && post.status !== "dry_run" ? `<p class="${post.status === "rejected" ? "note" : "warn"}">${esc(post.error)}</p>` : "";
  return `<div class="row" data-key="hist-${post.id}">
    <div class="row-main">${post.text || post.media.length ? tweetCard(post, { ago: when }) : `<div class="placeholder"><p class="muted">No content was produced.</p></div>`}</div>
    <aside class="slot-side">
      <div class="slot-head"><span class="pill pill-${tone}">${esc(label)}</span><span class="muted small">#${post.id} · ${esc(fmtTime(when, localTz))}</span></div>
      ${metaHtml(post)}
      ${err}
      ${link ? `<div class="actions">${link}</div>` : ""}
    </aside>
  </div>`;
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
        const oldSel = el.querySelector("select.fmt");
        const newSel = fresh.querySelector("select.fmt");
        if (oldSel && newSel) newSel.value = oldSel.value;
        el.replaceWith(fresh);
      }
      el = fresh;
    }
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null);
  });
  for (const [key, el] of existing) if (!keep.has(key)) el.remove();
}

// ---------- render ----------

function renderHeader(d) {
  const mode = d.mode === "live" ? `<span class="pill pill-live">Live</span>` : `<span class="pill pill-neutral">Dry run</span>`;
  const paused = d.paused
    ? `<span class="pill pill-stop">Paused</span><span class="muted small" title="${esc(d.paused)}">${esc(d.paused)}</span>`
    : `<span class="pill pill-go">Publishing on</span>`;
  const running = d.jobs.filter((j) => j.status === "running").length;
  $("#status").innerHTML = `${mode}${paused}${running ? `<span class="pill pill-busy"><span class="spinner sm" aria-hidden="true"></span>${running} writing</span>` : ""}`;
  const pb = $("#pause-btn");
  pb.textContent = d.paused ? "Resume publishing" : "Pause publishing";
  pb.dataset.paused = d.paused ? "1" : "";
  pb.disabled = state.busy.has("pause");

  $("#quotas").innerHTML = d.products
    .map((p) => {
      const pct = p.daily_cap ? Math.min(100, (p.today_count / p.daily_cap) * 100) : 100;
      const live = p.live ? "live" : "dry run";
      return `<div class="quota${p.enabled ? "" : " off"}" title="${esc(p.name)}: ${p.today_count} of ${p.daily_cap} posts today (${esc(p.timezone)}), ${live}">
        <span class="quota-name">${esc(p.name)}</span>
        <span class="meter" aria-hidden="true"><span style="width:${pct}%"></span></span>
        <span class="quota-num">${p.today_count} of ${p.daily_cap} today</span>${p.enabled ? "" : `<span class="muted small">disabled</span>`}
      </div>`;
    })
    .join("");

  const sel = $("#new-product");
  const want = d.products.map((p) => p.slug).join(",");
  if (sel.dataset.list !== want) {
    const prev = sel.value;
    sel.innerHTML = d.products.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join("");
    if (prev) sel.value = prev;
    sel.dataset.list = want;
  }
  const genBusy = d.jobs.some((j) => j.kind === "generate" && j.status === "running" && j.product === sel.value);
  const submit = $("#new-panel button[type=submit]");
  submit.disabled = genBusy || state.busy.has("generate");
  submit.textContent = genBusy ? "Writing…" : "Generate";
}

function render() {
  const d = state.data;
  if (!d) return;
  state.products = new Map(d.products.map((p) => [p.slug, p]));
  renderHeader(d);
  reconcile($("#upcoming"), d.upcoming, (s) => `slot-${s.id}`, slotHtml);
  $("#upcoming-empty").hidden = d.upcoming.length > 0;
  reconcile($("#ready"), d.ready, (p) => `post-${p.id}`, readyHtml);
  $("#ready-empty").hidden = d.ready.length > 0;
  reconcile($("#history"), state.history, (p) => `hist-${p.id}`, historyHtml);
  $("#history-empty").hidden = state.history.length > 0;
  $("#history-more").hidden = state.history.length >= state.historyTotal;
  $("#lede-upcoming").textContent = d.paused
    ? "Publishing is paused. Nothing goes out until you resume; posts past their time by more than 3 h are skipped."
    : "Posts publish automatically at their time unless you discard them.";
  $("#count-upcoming").textContent = d.upcoming.filter((s) => ["pending", "claimed", "generated"].includes(s.status)).length || "";
  $("#count-ready").textContent = d.ready.length || "";
  $("#count-history").textContent = state.historyTotal || "";
  tickClocks();
}

function tickClocks() {
  for (const el of document.querySelectorAll("[data-countdown]")) el.textContent = countdown(el.dataset.countdown);
  for (const el of document.querySelectorAll("[data-since]")) el.textContent = `for ${duration(Date.now() - Date.parse(el.dataset.since))}`;
  for (const el of document.querySelectorAll("[data-rel]")) el.textContent = relative(el.dataset.rel);
  for (const el of document.querySelectorAll("[data-ago]")) {
    const r = relative(el.dataset.ago);
    el.textContent = r === "now" ? "just now" : /^\d/.test(r) && !/[a-z]{3}/i.test(r) ? `${r} ago` : `on ${r}`;
  }
}

// ---------- refresh loop ----------

let timer = null;
let loading = null;

async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const [s, h] = await Promise.all([api("GET", "/api/state"), api("GET", `/api/history?offset=0&limit=${Math.max(50, state.history.length)}`)]);
      const wasRunning = new Set((state.data?.jobs ?? []).filter((j) => j.status === "running").map((j) => j.id));
      state.data = s;
      state.history = h.posts;
      state.historyTotal = h.total;
      for (const j of s.jobs) {
        if (!wasRunning.has(j.id) || j.status === "running") continue;
        const what = j.kind === "regenerate" ? `Slot ${j.slot_id}` : "New post";
        if (j.status === "done") toast(`${what}: post #${j.post_id} is ready to review.`, "ok");
        else toast(`${what}: ${j.error ?? "generation failed"}`, "error");
      }
      render();
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
  const fast = (state.data?.jobs ?? []).some((j) => j.status === "running") || (state.data?.upcoming ?? []).some((s) => s.status === "claimed");
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

function formatFor(id) {
  return document.querySelector(`select[data-format-for="${id}"]`)?.value ?? "auto";
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-action]");
  if (!b) return;
  const id = Number(b.dataset.id);
  const action = b.dataset.action;
  const live = state.data?.mode === "live";
  if (action === "discard") {
    const inSlot = state.data?.upcoming.some((s) => s.post?.id === id);
    if (!confirm(`Discard post #${id}? It will not be published${inSlot ? " and its slot will be skipped" : ""}.`)) return;
    run(`discard:${id}`, () => api("POST", `/api/posts/${id}/discard`), `Discarded post #${id}.`);
  } else if (action === "publish") {
    const where = live ? "to X now, for real" : "now (dry run: writes a preview, nothing goes to X)";
    if (!confirm(`Publish post #${id} ${where}?`)) return;
    run(`publish:${id}`, () => api("POST", `/api/posts/${id}/publish`), (r) => (r.result.mode === "live" ? `Published: ${r.result.url}` : `Dry run done for post #${id}.`));
  } else if (action === "regenerate") {
    const slot = state.data?.upcoming.find((s) => s.id === id);
    const replaces = slot?.post && slot.post.status === "approved";
    if (replaces && !confirm(`Discard post #${slot.post.id} and write a new one for slot ${id}?`)) return;
    run(`regenerate:${id}`, () => api("POST", `/api/slots/${id}/regenerate`, { format: formatFor(id) }), `Writing a new post for slot ${id}.`);
  } else if (action === "skip") {
    if (!confirm(`Skip slot ${id}? Nothing will be published at that time.`)) return;
    run(`skip:${id}`, () => api("POST", `/api/slots/${id}/skip`), `Skipped slot ${id}.`);
  }
});

$("#pause-btn").addEventListener("click", () => {
  const paused = $("#pause-btn").dataset.paused === "1";
  if (paused) {
    run("pause", () => api("POST", "/api/resume"), (r) => (r.paused ? `Still paused: ${r.paused}` : "Publishing resumed."));
  } else {
    const reason = prompt("Pause all publishing. Reason (optional):", "");
    if (reason === null) return;
    run("pause", () => api("POST", "/api/pause", { reason }), "Publishing paused.");
  }
});

$("#new-btn").addEventListener("click", () => {
  const panel = $("#new-panel");
  panel.hidden = !panel.hidden;
  $("#new-btn").setAttribute("aria-expanded", String(!panel.hidden));
});

$("#new-panel").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const product = $("#new-product").value;
  const format = $("#new-format").value;
  run("generate", () => api("POST", "/api/generate", { product, format }), "Writing a new post. It will appear in Ready.");
  $("#new-panel").hidden = true;
  $("#new-btn").setAttribute("aria-expanded", "false");
});

$("#history-more").addEventListener("click", async () => {
  try {
    const h = await api("GET", `/api/history?offset=${state.history.length}&limit=50`);
    state.history = state.history.concat(h.posts);
    state.historyTotal = h.total;
    render();
  } catch (e) {
    toast(e.message, "error");
  }
});

function showTab(tab) {
  state.tab = tab;
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === tab));
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${tab}`;
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
}
for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => showTab(t.dataset.tab));
const tabFromHash = () => (["upcoming", "ready", "history"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "upcoming");
showTab(tabFromHash());
window.addEventListener("hashchange", () => showTab(tabFromHash()));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
setInterval(tickClocks, 1000);
refresh();
