// Account selector and the add / edit account form. Vanilla JS, no build step.

const LS_KEY = "autocm.account";
const UPLOAD_MB = { logo: 2, screen: 10, clip: 64, font: 2 };
const STRING_LISTS = ["voice.rules", "voice.banned_phrases", "voice.example_posts"];
const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();
const LANGS = ["en", "es", "pt", "fr", "de", "it", "nl", "pl", "sv", "ja", "ko", "zh"];
const COLOR_KEYS = [
  ["primary", "Primary", "Buttons, highlights"],
  ["accent", "Accent", "Second brand color"],
  ["ink", "Ink", "Dark text / dark backgrounds"],
  ["bg", "Background", "Light background"],
  ["muted", "Muted", "Secondary text (optional)"],
];

export function loadSelected() {
  try {
    return localStorage.getItem(LS_KEY) || null;
  } catch {
    return null;
  }
}

function saveSelected(slug) {
  try {
    if (slug) localStorage.setItem(LS_KEY, slug);
    else localStorage.removeItem(LS_KEY);
  } catch {
    // private mode / storage blocked: the choice just is not remembered
  }
}

export function slugify(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const CADENCE_FIELDS = [
  ["posts_per_day_min", "Posts per day, fewest", 'min="0" max="10" step="1"', "Each day draws a count between these two"],
  ["posts_per_day_max", "Posts per day, most", 'min="0" max="10" step="1"', ""],
  ["daily_cap", "Daily cap", 'min="0" max="20" step="1"', "Hard limit per day"],
  ["min_gap_min", "Minimum gap (min)", 'min="0" step="5"', "Between two posts"],
];

function defaults() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  return {
    name: "",
    url: "",
    handle: "",
    enabled: true,
    language: "en",
    timezone: tz,
    one_liner: "",
    audience: "",
    voice: { rules: [""], banned_phrases: [], example_posts: [] },
    pillars: [{ id: "", description: "", weight: 1 }],
    format_mix: { text: 0.4, image: 0.4, video: 0.2 },
    cadence: { posts_per_day_min: 1, posts_per_day_max: 2, windows: ["09:00-11:00", "13:00-16:00"], daily_cap: 3, min_gap_min: 90 },
    brand: {
      colors: { primary: "#4F46E5", accent: "#818CF8", ink: "#09090B", bg: "#FAFAFA", muted: "#71717A" },
      fonts: { sans: "Geist", mono: "Geist Mono", files: [] },
      logo: "",
    },
    assets: { clips: [], screens: [] },
    links: { cta_url: "", utm: "", max_link_ratio: 0.34 },
    hashtags: { max_per_post: 1 },
  };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

/** Defaults under the loaded values, so a product.yaml with missing keys still renders every field. */
function withDefaults(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? clone(base) : clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? withDefaults(base[k], v) : clone(v);
  return out;
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null || typeof o[k] !== "object") o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys.at(-1)] = value;
}

function hex6(v) {
  const s = String(v ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return "#" + [...s.slice(1)].map((c) => c + c).join("");
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7);
  return "#000000";
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

export function createAccounts(ctx) {
  const { $, esc, api, toast, refresh, state } = ctx;
  let model = null; // the open form
  let prefillTimer = null;

  // ---------- avatars ----------

  function avatarHtml(p, cls = "av") {
    if (p?.x?.avatar_url) return `<img class="${cls}" src="${esc(p.x.avatar_url)}" alt="" loading="lazy">`;
    const initial = (p?.name || p?.slug || "?").trim().charAt(0).toUpperCase();
    return `<span class="${cls}" style="--av:${esc(p?.color || "#5f6873")}" aria-hidden="true">${esc(initial)}</span>`;
  }

  // ---------- selector ----------

  function products() {
    return state.data?.products ?? [];
  }

  function select(slug, { toPosts = true } = {}) {
    if (toPosts && isOpen() && !confirmLeave()) return;
    state.selected = slug || null;
    saveSelected(state.selected);
    closeMenu();
    if (toPosts && isOpen()) {
      if (model) model.dirty = false;
      location.hash = "";
    }
    refresh();
  }

  function subline(p) {
    if (p.invalid) return `<span class="acct-sub err">product.yaml has errors</span>`;
    if (connectJob(p.slug)) return `<span class="acct-sub busy">connecting…</span>`;
    if (p.x?.error) return `<span class="acct-sub err">@${esc(p.x.handle)} · session problem</span>`;
    if (p.x) return `<span class="acct-sub">@${esc(p.x.handle)}</span>`;
    return `<span class="acct-sub">not connected</span>`;
  }

  function renderSelector() {
    const list = products();
    if (state.selected && state.data && !list.some((p) => p.slug === state.selected)) {
      state.selected = null;
      saveSelected(null);
    }
    const cur = list.find((p) => p.slug === state.selected);
    $("#acct-btn").innerHTML = cur
      ? `${avatarHtml(cur)}<span class="acct-label"><span class="acct-name">${esc(cur.name)}</span>${cur.x ? `<span class="acct-handle">@${esc(cur.x.handle)}</span>` : ""}</span><span class="caret" aria-hidden="true"></span>`
      : `<span class="av av-all" aria-hidden="true">${list.slice(0, 3).map((p) => `<i style="--av:${esc(p.color)}"></i>`).join("")}</span><span class="acct-label"><span class="acct-name">All accounts</span></span><span class="caret" aria-hidden="true"></span>`;

    const rows = list
      .map((p) => {
        const tools = [];
        if (!p.x && !p.invalid && !connectJob(p.slug)) tools.push(`<button type="button" class="mini" data-acct-connect="${esc(p.slug)}">Connect X</button>`);
        if (p.x?.error && !connectJob(p.slug)) tools.push(`<button type="button" class="mini mini-warn" data-acct-connect="${esc(p.slug)}">Reconnect</button>`);
        tools.push(`<button type="button" class="mini" data-acct-edit="${esc(p.slug)}" aria-label="Edit ${esc(p.name)}">Edit</button>`);
        return `<div class="acct-row${p.enabled ? "" : " off"}">
          <button type="button" class="acct-item" role="menuitemradio" aria-checked="${p.slug === state.selected}" data-acct-select="${esc(p.slug)}">
            ${avatarHtml(p)}<span class="acct-text"><span class="acct-name">${esc(p.name)}${p.enabled ? "" : ` <span class="muted small">disabled</span>`}</span>${subline(p)}</span>
          </button>
          <div class="acct-tools">${tools.join("")}</div>
        </div>`;
      })
      .join("");
    $("#acct-menu").innerHTML = `
      <div class="acct-row"><button type="button" class="acct-item" role="menuitemradio" aria-checked="${!state.selected}" data-acct-select="">
        <span class="av av-all" aria-hidden="true">${list.slice(0, 3).map((p) => `<i style="--av:${esc(p.color)}"></i>`).join("")}</span>
        <span class="acct-text"><span class="acct-name">All accounts</span><span class="acct-sub">${list.length} ${list.length === 1 ? "account" : "accounts"}</span></span>
      </button></div>
      ${rows}
      <div class="acct-sep" role="separator"></div>
      <a class="acct-item acct-add" role="menuitem" href="#account/new"><span class="av av-plus" aria-hidden="true">+</span><span class="acct-text"><span class="acct-name">Add account</span><span class="acct-sub">A product and its X account</span></span></a>`;
  }

  function openMenu() {
    $("#acct-menu").hidden = false;
    $("#acct-btn").setAttribute("aria-expanded", "true");
  }

  function closeMenu() {
    $("#acct-menu").hidden = true;
    $("#acct-btn").setAttribute("aria-expanded", "false");
  }

  $("#acct-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    if ($("#acct-menu").hidden) openMenu();
    else closeMenu();
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#acct")) closeMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("#acct-menu").hidden) {
      closeMenu();
      $("#acct-btn").focus();
    }
  });
  $("#acct-menu").addEventListener("click", (ev) => {
    const sel = ev.target.closest("[data-acct-select]");
    const edit = ev.target.closest("[data-acct-edit]");
    const conn = ev.target.closest("[data-acct-connect]");
    if (sel) select(sel.dataset.acctSelect);
    else if (edit) {
      closeMenu();
      location.hash = `#account/${edit.dataset.acctEdit}`;
    } else if (conn) {
      closeMenu();
      connect(conn.dataset.acctConnect);
    } else if (ev.target.closest(".acct-add")) closeMenu();
  });

  // ---------- connect X ----------

  function connectJob(slug) {
    return (state.data?.account_jobs ?? []).find((j) => j.kind === "connect" && j.product === slug && j.status === "running");
  }

  async function connect(slug) {
    const p = products().find((x) => x.slug === slug);
    const name = p?.name ?? slug;
    if (!confirm(`A browser window opens on this computer. Log in there to the X account that posts for ${name}; it closes by itself when you are in.`)) return;
    try {
      await api("POST", `/api/products/${encodeURIComponent(slug)}/x/connect`);
      toast(`Log in to X for ${name} in the window that opened.`, "ok");
    } catch (e) {
      toast(e.message, "error");
    }
    await refresh();
  }

  async function disconnect(slug) {
    const p = products().find((x) => x.slug === slug);
    if (!confirm(`Disconnect @${p?.x?.handle ?? slug}? Its browser session is deleted and nothing publishes for ${p?.name ?? slug} until you connect again.`)) return;
    try {
      await api("POST", `/api/products/${encodeURIComponent(slug)}/x/disconnect`);
      toast("X disconnected.", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
    await refresh();
  }

  function xCardHtml() {
    if (!model || model.mode !== "edit") return "";
    const p = products().find((x) => x.slug === model.slug) ?? model.account;
    const job = connectJob(model.slug);
    const lastFailed = (state.data?.account_jobs ?? []).find((j) => j.kind === "connect" && j.product === model.slug);
    const fmt = (iso) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    let body;
    if (job) {
      body = `<div class="x-state"><span class="spinner" aria-hidden="true"></span><div><strong>Waiting for you to log in</strong><p class="muted small">${esc(job.step || "Log in to X in the window that opened")}. The window closes by itself when you are in.</p></div></div>`;
    } else if (p?.x) {
      const x = p.x;
      body = `<div class="x-state">${avatarHtml(p, "av av-lg")}<div class="x-who"><strong>${esc(x.name || x.handle)}</strong><span class="muted">@${esc(x.handle)}</span>
        <span class="muted small">Connected ${esc(fmt(x.connected_at))}${x.last_ok_at ? ` · session checked ${esc(fmt(x.last_ok_at))}` : ""}</span></div></div>
        ${x.error ? `<p class="warn">Session problem: ${esc(x.error)}. Posts for this account are held until you reconnect.</p>` : ""}
        <div class="actions">${x.error ? `<button type="button" class="btn btn-primary" data-x="connect">Reconnect</button>` : ""}<button type="button" class="btn btn-danger" data-x="disconnect">Disconnect</button></div>`;
    } else {
      body = `<div class="x-state"><span class="av av-lg av-empty" aria-hidden="true">X</span><div><strong>Not connected</strong><p class="muted small">Posts are written and shown here but never published until an X account is connected.</p></div></div>
        ${lastFailed?.status === "failed" ? `<p class="warn">Last attempt failed: ${esc(lastFailed.error ?? "unknown error")}</p>` : ""}
        <div class="actions"><button type="button" class="btn btn-primary" data-x="connect">Connect X</button></div>`;
    }
    return `<h2>X account</h2><p class="hint">autocm posts through a logged-in browser session for this account. Connecting opens a window on this computer where you log in.</p>${body}`;
  }

  function renderXCard() {
    const el = document.getElementById("x-card");
    if (!el) return;
    const html = xCardHtml();
    if (el.dataset.sig !== html) {
      el.innerHTML = html;
      el.dataset.sig = html;
    }
  }

  // ---------- account view ----------

  function isOpen() {
    return !$("#view-account").hidden;
  }

  async function openView(target) {
    clearInterval(prefillTimer);
    closeMenu();
    const root = $("#account-root");
    if (target === "new") {
      model = { mode: "create", slug: "", slugTouched: false, config: defaults(), knowledge: [{ name: "00-overview.md", content: "", isNew: true, open: true }], knowledgeDelete: [], logo: null, fontUploads: [], errors: {}, notes: [], prefill: null, dirty: false, saving: false, uploading: 0 };
      renderForm();
      return;
    }
    const slug = target;
    model = null;
    root.innerHTML = `<p class="muted loading"><span class="spinner sm" aria-hidden="true"></span> Loading ${esc(slug)}…</p>`;
    try {
      const r = await api("GET", `/api/products/${encodeURIComponent(slug)}`);
      model = {
        mode: "edit",
        slug,
        account: r.account,
        config: withDefaults(defaults(), r.config),
        knowledge: r.knowledge.map((k) => ({ ...k, open: false })),
        knowledgeDelete: [],
        logo: null,
        fontUploads: [],
        errors: r.errors ?? {},
        notes: Object.keys(r.errors ?? {}).length ? ["The saved product.yaml has problems; they are marked below."] : [],
        prefill: null,
        dirty: false,
        saving: false,
        uploading: 0,
      };
      if (model.knowledge.length === 1) model.knowledge[0].open = true;
      renderForm();
    } catch (e) {
      root.innerHTML = `<p class="warn">${esc(e.message)}</p><p><a href="#">Back to Up next</a></p>`;
    }
  }

  function closeView() {
    clearInterval(prefillTimer);
    model = null;
  }

  function confirmLeave() {
    return !model?.dirty || confirm("Leave without saving? Your changes to this account are lost.");
  }

  window.addEventListener("beforeunload", (ev) => {
    if (model?.dirty) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  // ---------- form rendering ----------

  const v = (path) => getPath(model.config, path);

  function input(path, attrs = "", type = "text") {
    const val = v(path);
    return `<input type="${type}" data-k="${path}" ${type === "number" ? 'data-t="num"' : ""} value="${esc(val ?? "")}" ${attrs}>`;
  }

  function field(label, path, control, hint = "", cls = "") {
    return `<label class="field ${cls}" data-path="${path}"><span class="lbl">${label}</span>${control}${hint ? `<small class="help">${hint}</small>` : ""}</label>`;
  }

  function strList(path, { multiline = false, placeholder = "", add = "Add", rows = 2 } = {}) {
    const items = v(path) ?? [];
    const row = (item, i) => `<div class="list-row" data-path="${path}.${i}">
        ${multiline ? `<textarea data-k="${path}.${i}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(item)}</textarea>` : `<input type="text" data-k="${path}.${i}" value="${esc(item)}" placeholder="${esc(placeholder)}">`}
        <button type="button" class="icon-btn" data-act="list-del" data-list="${path}" data-i="${i}" aria-label="Remove">×</button>
      </div>`;
    return `<div class="list" data-path="${path}">${items.map(row).join("")}<button type="button" class="btn btn-ghost" data-act="list-add" data-list="${path}">+ ${esc(add)}</button></div>`;
  }

  function pillarsHtml() {
    const rows = (v("pillars") ?? [])
      .map(
        (p, i) => `<div class="pillar" data-path="pillars.${i}">
        <label class="field" data-path="pillars.${i}.id"><span class="lbl">Id</span><input type="text" data-k="pillars.${i}.id" value="${esc(p.id)}" placeholder="pain"></label>
        <label class="field" data-path="pillars.${i}.weight"><span class="lbl">Weight</span><input type="number" min="0.1" step="0.5" data-t="num" data-k="pillars.${i}.weight" value="${esc(p.weight)}"></label>
        <label class="field span" data-path="pillars.${i}.description"><span class="lbl">What posts in this pillar talk about</span><textarea data-k="pillars.${i}.description" rows="2">${esc(p.description)}</textarea></label>
        <button type="button" class="icon-btn" data-act="list-del" data-list="pillars" data-i="${i}" aria-label="Remove pillar">×</button>
      </div>`,
      )
      .join("");
    return `<div class="list" data-path="pillars">${rows}<button type="button" class="btn btn-ghost" data-act="pillar-add">+ Add pillar</button></div>`;
  }

  function windowsHtml() {
    const rows = (v("cadence.windows") ?? [])
      .map((w, i) => {
        const [a = "", b = ""] = String(w).split("-");
        return `<div class="list-row win" data-path="cadence.windows.${i}">
          <input type="time" data-win="${i}" data-part="0" value="${esc(a)}" aria-label="From"><span class="muted">to</span><input type="time" data-win="${i}" data-part="1" value="${esc(b)}" aria-label="To">
          <button type="button" class="icon-btn" data-act="list-del" data-list="cadence.windows" data-i="${i}" aria-label="Remove window">×</button>
        </div>`;
      })
      .join("");
    return `<div class="list" data-path="cadence.windows">${rows}<button type="button" class="btn btn-ghost" data-act="window-add">+ Add window</button></div>`;
  }

  function mixHtml() {
    const m = v("format_mix") ?? {};
    const total = ["text", "image", "video"].reduce((s, k) => s + (Number(m[k]) || 0), 0);
    const pct = (k) => (total > 0 ? Math.round(((Number(m[k]) || 0) / total) * 100) : 0);
    return `<div class="mix" data-path="format_mix">${["text", "image", "video"]
      .map(
        (k) => `<label class="field" data-path="format_mix.${k}"><span class="lbl">${k[0].toUpperCase() + k.slice(1)} <span class="muted" data-pct="${k}">${pct(k)}%</span></span>
          <input type="number" min="0" step="0.1" data-t="num" data-k="format_mix.${k}" value="${esc(m[k] ?? 0)}"></label>`,
      )
      .join("")}</div>`;
  }

  function colorsHtml() {
    return `<div class="colors">${COLOR_KEYS.map(([k, label, hint]) => {
      const val = v(`brand.colors.${k}`) ?? "";
      return `<div class="field" data-path="brand.colors.${k}"><span class="lbl">${label}</span>
        <div class="color-row"><input type="color" data-color="${k}" value="${esc(hex6(val || "#71717A"))}" aria-label="${label} color"><input type="text" data-k="brand.colors.${k}" value="${esc(val)}" placeholder="#000000" spellcheck="false"></div>
        <small class="help">${hint}</small></div>`;
    }).join("")}</div>`;
  }

  function logoUrl() {
    if (model.logo?.url) return model.logo.url;
    const rel = v("brand.logo");
    if (model.mode === "edit" && rel) return `/api/products/${encodeURIComponent(model.slug)}/file?path=${encodeURIComponent(rel)}`;
    return null;
  }

  function logoHtml() {
    const url = logoUrl();
    const c = v("brand.colors") ?? {};
    const preview = url
      ? `<div class="logo-previews"><div class="logo-box" style="background:${esc(hex6(c.bg || "#FAFAFA"))}"><img src="${esc(url)}" alt="Logo on the light background"></div><div class="logo-box" style="background:${esc(hex6(c.ink || "#09090B"))}"><img src="${esc(url)}" alt="Logo on the dark background"></div></div>`
      : `<div class="logo-previews"><div class="logo-box empty">No logo yet</div></div>`;
    const src = model.logo ? `New upload: ${esc(model.logo.name || "logo")}` : v("brand.logo") ? esc(v("brand.logo")) : "";
    return `<div class="field" data-path="brand.logo"><span class="lbl">Logo</span>${preview}
      <div class="upload-line"><label class="btn btn-ghost file-btn">${url ? "Replace logo" : "Upload logo"}<input type="file" accept=".svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp" data-upload="logo" hidden></label><span class="muted small">${src || "SVG preferred, or PNG/JPG/WebP up to 2 MB"}</span></div></div>`;
  }

  function fontsHtml() {
    const files = v("brand.fonts.files") ?? [];
    const list = [
      ...files.map((f, i) => `<li data-path="brand.fonts.files.${i}"><code>${esc(String(f).split("/").pop())}</code><button type="button" class="icon-btn" data-act="list-del" data-list="brand.fonts.files" data-i="${i}" aria-label="Remove font file">×</button></li>`),
      ...model.fontUploads.map((f, i) => `<li><code>${esc(f.name)}</code> <span class="muted small">new</span><button type="button" class="icon-btn" data-act="font-up-del" data-i="${i}" aria-label="Remove font upload">×</button></li>`),
    ];
    const geistNote = model.mode === "create" && !model.fontUploads.length ? `<small class="help">With family Geist and no uploads, Geist and Geist Mono are copied into the product.</small>` : "";
    return `<div class="grid">
        ${field("Sans family", "brand.fonts.sans", input("brand.fonts.sans", 'placeholder="Geist"'))}
        ${field("Mono family", "brand.fonts.mono", input("brand.fonts.mono", 'placeholder="Geist Mono"'), "Optional")}
      </div>
      <div class="field" data-path="brand.fonts.files"><span class="lbl">Font files</span>
        ${list.length ? `<ul class="files">${list.join("")}</ul>` : `<p class="muted small">None. Renders fall back to Geist.</p>`}
        <div class="upload-line"><label class="btn btn-ghost file-btn">Upload woff2<input type="file" accept=".woff2,font/woff2" data-upload="font" multiple hidden></label></div>${geistNote}
      </div>`;
  }

  function mediaHtml(kind) {
    const key = kind === "screen" ? "screens" : "clips";
    const items = v(`assets.${key}`) ?? [];
    const rows = items
      .map((it, i) => {
        const src = it._preview || (it.path && model.mode === "edit" ? `/api/products/${encodeURIComponent(model.slug)}/file?path=${encodeURIComponent(it.path)}` : "");
        const preview = !src
          ? `<div class="media-thumb empty">no preview</div>`
          : kind === "screen"
            ? `<img class="media-thumb" src="${esc(src)}" alt="" loading="lazy">`
            : `<video class="media-thumb" src="${esc(src)}" preload="metadata" muted playsinline controls></video>`;
        const at = `assets.${key}.${i}`;
        return `<div class="media-item" data-path="${at}">
          ${preview}
          <div class="media-fields">
            <div class="grid tight">
              ${field("Id", `${at}.id`, `<input type="text" data-k="${at}.id" value="${esc(it.id ?? "")}" placeholder="${kind === "screen" ? "home" : "demo"}">`)}
              ${kind === "clip" ? field("Start (s)", `${at}.start`, `<input type="number" min="0" step="0.1" data-t="num" data-k="${at}.start" value="${esc(it.start ?? "")}">`, "Optional") + field("End (s)", `${at}.end`, `<input type="number" min="0" step="0.1" data-t="num" data-k="${at}.end" value="${esc(it.end ?? "")}">`, "Optional") : ""}
            </div>
            ${field("What is on screen", `${at}.description`, `<textarea data-k="${at}.description" rows="2" placeholder="${kind === "clip" ? "16:9, 6 s. The editor groups saved links by neighbourhood; voiceover: …" : "Dashboard with three trips and the day plan for Lisbon"}">${esc(it.description ?? "")}</textarea>`)}
            <div class="media-meta"><span class="muted small">${esc(it.upload ? `New upload: ${it._name ?? ""}` : (it.path ?? ""))}</span><span class="field-anchor" data-path="${at}.path"></span>
            <button type="button" class="btn btn-danger btn-sm" data-act="list-del" data-list="assets.${key}" data-i="${i}">Remove</button></div>
          </div>
        </div>`;
      })
      .join("");
    const accept = kind === "screen" ? ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" : ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm";
    return `<div class="media-list" data-path="assets.${key}">${rows || `<p class="muted small">None yet.</p>`}
      <div class="upload-line"><label class="btn btn-ghost file-btn">+ Add ${kind === "screen" ? "screenshot" : "clip"}<input type="file" accept="${accept}" data-upload="${kind}" multiple hidden></label>
      <span class="muted small">${kind === "screen" ? "PNG, JPG or WebP up to 10 MB. Used by the screenshot template." : "MP4 (H.264 + AAC) up to 64 MB. The strategist picks clips by their description."}</span></div></div>`;
  }

  function knowledgeHtml() {
    const files = model.knowledge
      .map((k, i) => {
        const size = new Blob([k.content]).size;
        return `<details class="kfile" data-kidx="${i}" ${k.open ? "open" : ""} data-path="knowledge.${i}">
          <summary><span class="kname">${esc(k.name || "untitled.md")}</span><span class="muted small">${size ? `${(size / 1024).toFixed(1)} KB` : "empty"}${k.isNew ? " · new" : ""}</span></summary>
          <div class="kbody">
            ${k.isNew ? field("File name", `knowledge.${i}.name`, `<input type="text" data-kn="${i}" data-kf="name" value="${esc(k.name)}" placeholder="10-features.md" spellcheck="false">`, "Files are read in name order") : ""}
            <label class="field" data-path="knowledge.${i}.content"><span class="lbl">Markdown</span><textarea class="mono" data-kn="${i}" data-kf="content" rows="16" spellcheck="true">${esc(k.content)}</textarea></label>
            <div class="actions"><button type="button" class="btn btn-danger btn-sm" data-act="kdel" data-i="${i}">Delete file</button></div>
          </div>
        </details>`;
      })
      .join("");
    return `<div class="knowledge" data-path="knowledge">${files}<button type="button" class="btn btn-ghost" data-act="kadd">+ Add knowledge file</button></div>`;
  }

  function prefillHtml() {
    if (model.mode !== "create") return "";
    const pf = model.prefill;
    const running = pf && pf.status === "running";
    let status = "";
    if (running) status = `<p class="pf-status"><span class="spinner sm" aria-hidden="true"></span> ${esc(pf.step || "Starting the browser")}…</p>`;
    else if (pf?.status === "failed") status = `<p class="warn">${esc(pf.error || "Could not read the website")}</p>`;
    else if (pf?.status === "done") {
      status = `<div class="note pf-done"><strong>Draft filled in from ${esc(pf.sources.length)} page${pf.sources.length === 1 ? "" : "s"}.</strong> Review every field before saving.
        <ul>${pf.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
        <details><summary>Pages read</summary><ul>${pf.sources.map((s) => `<li><code>${esc(s)}</code></li>`).join("")}</ul></details></div>`;
    }
    return `<section class="fs fs-prefill">
      <h2>Start from the website</h2>
      <p class="hint">Reads the homepage and a few pages like pricing, features and about in a hidden browser, then drafts every field below plus an overview knowledge file. Nothing is saved until you press Create account.</p>
      <form class="pf-row" data-act-form="prefill">
        <input type="url" id="pf-url" placeholder="https://yourproduct.com" value="${esc(pf?.url ?? v("url") ?? "")}" ${running ? "disabled" : ""} aria-label="Product website">
        <button type="submit" class="btn btn-primary" ${running ? "disabled" : ""}>${running ? "Reading…" : "Fill from website"}</button>
      </form>
      ${status}
    </section>`;
  }

  function renderForm() {
    const root = $("#account-root");
    const create = model.mode === "create";
    const title = create ? "Add account" : esc(v("name") || model.slug);
    const slugCtl = create
      ? `<input type="text" id="slug" value="${esc(model.slug)}" placeholder="from the name" spellcheck="false" pattern="[a-z0-9-]+">`
      : `<input type="text" value="${esc(model.slug)}" readonly>`;
    const tzList = `<datalist id="tz-list">${TIMEZONES.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>`;
    const langList = `<datalist id="lang-list">${LANGS.map((t) => `<option value="${t}">`).join("")}</datalist>`;
    const scrollY = window.scrollY;
    root.innerHTML = `
      <div class="acct-head">
        <a href="#upcoming" class="btn btn-ghost back" data-act="back">← Up next</a>
        <div><h1>${title}</h1><p class="muted small">${create ? "A product and the X account that posts for it." : `products/${esc(model.slug)}/`}</p></div>
      </div>
      ${model.notes.length ? `<div class="note">${model.notes.map((n) => `<p>${esc(n)}</p>`).join("")}</div>` : ""}
      ${prefillHtml()}
      <form class="acct-form" id="acct-form" novalidate>
        ${create ? "" : `<section class="fs" id="x-card"></section>`}
        <section class="fs">
          <h2>Basics</h2>
          <div class="grid">
            ${field("Name", "name", input("name", 'placeholder="Acme" autocomplete="off"'))}
            ${field("Slug", "slug", slugCtl, create ? "Folder name and id; cannot change later" : "Cannot change")}
            ${field("Website", "url", input("url", 'placeholder="https://acme.com"', "url"))}
            ${field("X handle", "handle", input("handle", 'placeholder="acmehq"'), "Optional; the connected account's handle wins")}
            ${field("Post language", "language", input("language", 'list="lang-list" placeholder="en"'), "ISO code, e.g. en, es")}
            ${field("Time zone", "timezone", input("timezone", 'list="tz-list" placeholder="America/New_York"'), "Posting windows are in this zone")}
          </div>
          <label class="check" data-path="enabled"><input type="checkbox" data-k="enabled" data-t="bool" ${v("enabled") !== false ? "checked" : ""}> <span>Enabled: plan and publish posts for this account</span></label>
          ${tzList}${langList}
        </section>

        <section class="fs">
          <h2>Positioning</h2>
          <p class="hint">The planner reads these on every post.</p>
          ${field("One-liner", "one_liner", `<textarea data-k="one_liner" rows="2" placeholder="What it does and for whom, in one sentence">${esc(v("one_liner") ?? "")}</textarea>`)}
          ${field("Audience", "audience", `<textarea data-k="audience" rows="2" placeholder="Who buys it and who uses it">${esc(v("audience") ?? "")}</textarea>`)}
        </section>

        <section class="fs">
          <h2>Voice</h2>
          <div class="field" data-path="voice.rules"><span class="lbl">Rules</span>${strList("voice.rules", { placeholder: "Short declarative sentences. No hype.", add: "Add rule" })}</div>
          <div class="field" data-path="voice.banned_phrases"><span class="lbl">Banned phrases</span>${strList("voice.banned_phrases", { placeholder: "game-changer", add: "Add phrase" })}</div>
          <div class="field" data-path="voice.example_posts"><span class="lbl">Example posts</span><small class="help">Real lines to imitate.</small>${strList("voice.example_posts", { multiline: true, placeholder: "A post in the voice you want", add: "Add example" })}</div>
        </section>

        <section class="fs">
          <h2>Pillars</h2>
          <p class="hint">Content themes. Weight is the relative share of posts.</p>
          ${pillarsHtml()}
        </section>

        <section class="fs">
          <h2>Formats and cadence</h2>
          <div class="field"><span class="lbl">Format mix</span><small class="help">Relative share of text, image and video posts.</small>${mixHtml()}</div>
          <div class="grid" data-path="cadence">
            ${CADENCE_FIELDS.map(([key, label, attrs, help]) => field(label, `cadence.${key}`, input(`cadence.${key}`, attrs, "number"), help)).join("")}
          </div>
          <div class="field" data-path="cadence.windows"><span class="lbl">Posting windows</span>${windowsHtml()}</div>
        </section>

        <section class="fs">
          <h2>Brand</h2>
          ${logoHtml()}
          ${colorsHtml()}
          ${fontsHtml()}
        </section>

        <section class="fs">
          <h2>Links and hashtags</h2>
          <div class="grid">
            ${field("Link for calls to action", "links.cta_url", input("links.cta_url", 'placeholder="https://acme.com/pricing"', "url"))}
            ${field("UTM parameters", "links.utm", input("links.utm", 'placeholder="utm_source=x&utm_medium=social"'), "Optional")}
            ${field("Max share of posts with a link", "links.max_link_ratio", input("links.max_link_ratio", 'min="0" max="1" step="0.01"', "number"), "0 to 1")}
            ${field("Hashtags per post (max)", "hashtags.max_per_post", input("hashtags.max_per_post", 'min="0" step="1"', "number"))}
          </div>
        </section>

        <section class="fs">
          <h2>Knowledge</h2>
          <p class="hint">The only truth the agents use about the product. Keep it factual and end with a "Facts you must not claim" list.</p>
          ${knowledgeHtml()}
        </section>

        <section class="fs">
          <h2>Screenshots</h2>
          ${mediaHtml("screen")}
        </section>
        <section class="fs">
          <h2>Video clips</h2>
          ${mediaHtml("clip")}
        </section>

        <div class="save-bar">
          <button type="submit" class="btn btn-primary" ${model.saving || model.uploading ? "disabled" : ""}>${model.saving ? "Saving…" : model.uploading ? "Uploading…" : create ? "Create account" : "Save changes"}</button>
          <a href="#upcoming" class="btn btn-ghost" data-act="back">Cancel</a>
          <span class="save-msg" id="save-msg">${Object.keys(model.errors).length ? `<span class="err">${Object.keys(model.errors).length} field${Object.keys(model.errors).length === 1 ? "" : "s"} to fix</span>` : model.dirty ? "Unsaved changes" : ""}</span>
        </div>
      </form>`;
    showErrors();
    renderXCard();
    window.scrollTo(0, scrollY);
  }

  function showErrors() {
    const root = $("#account-root");
    const unplaced = [];
    for (const [path, msg] of Object.entries(model.errors)) {
      let el = null;
      let p = path;
      while (p && !el) {
        el = root.querySelector(`[data-path="${CSS.escape(p)}"]`);
        if (!el) p = p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "";
      }
      if (!el) {
        unplaced.push(`${path}: ${msg}`);
        continue;
      }
      el.classList.add("has-error");
      const e = document.createElement("p");
      e.className = "field-error";
      e.textContent = p === path ? msg : `${path.slice(p.length + 1)}: ${msg}`;
      if (el.tagName === "DETAILS") {
        el.open = true;
        el.querySelector(".kbody")?.append(e);
      } else el.append(e);
    }
    if (unplaced.length) {
      const box = document.createElement("div");
      box.className = "warn";
      box.textContent = unplaced.join(" · ");
      root.querySelector("#acct-form")?.prepend(box);
    }
  }

  function markDirty() {
    model.dirty = true;
    const m = document.getElementById("save-msg");
    if (m && !Object.keys(model.errors).length) m.textContent = "Unsaved changes";
  }

  // ---------- form events ----------

  const root = $("#account-root");

  root.addEventListener("input", (ev) => {
    if (!model) return;
    const t = ev.target;
    if (t.id === "pf-url") return;
    if (t.id === "slug") {
      model.slug = t.value.trim();
      model.slugTouched = true;
      return markDirty();
    }
    if (t.dataset.k) {
      let val = t.value;
      if (t.dataset.t === "num") val = t.value === "" ? undefined : Number(t.value);
      if (t.dataset.t === "bool") val = t.checked;
      setPath(model.config, t.dataset.k, val);
      if (t.dataset.k === "name" && model.mode === "create" && !model.slugTouched) {
        model.slug = slugify(t.value);
        const s = document.getElementById("slug");
        if (s) s.value = model.slug;
      }
      if (t.dataset.k.startsWith("brand.colors.") && /^#[0-9a-f]{3,8}$/i.test(t.value)) {
        const c = root.querySelector(`input[data-color="${t.dataset.k.split(".").pop()}"]`);
        if (c) c.value = hex6(t.value);
      }
      if (t.dataset.k.startsWith("format_mix.")) {
        const m = v("format_mix");
        const total = ["text", "image", "video"].reduce((s, k) => s + (Number(m[k]) || 0), 0);
        for (const k of ["text", "image", "video"]) {
          const el = root.querySelector(`[data-pct="${k}"]`);
          if (el) el.textContent = `${total > 0 ? Math.round(((Number(m[k]) || 0) / total) * 100) : 0}%`;
        }
      }
      if (t.dataset.k.startsWith("assets.") && t.dataset.k.endsWith(".id")) t.value = t.value.toLowerCase();
      return markDirty();
    }
    if (t.dataset.color) {
      setPath(model.config, `brand.colors.${t.dataset.color}`, t.value.toUpperCase());
      const txt = root.querySelector(`input[data-k="brand.colors.${t.dataset.color}"]`);
      if (txt) txt.value = t.value.toUpperCase();
      return markDirty();
    }
    if (t.dataset.win !== undefined) {
      const i = Number(t.dataset.win);
      const [a = "", b = ""] = String(v("cadence.windows")[i] ?? "-").split("-");
      const parts = [a, b];
      parts[Number(t.dataset.part)] = t.value;
      v("cadence.windows")[i] = `${parts[0]}-${parts[1]}`;
      return markDirty();
    }
    if (t.dataset.kn !== undefined) {
      const k = model.knowledge[Number(t.dataset.kn)];
      k[t.dataset.kf] = t.value;
      if (t.dataset.kf === "name") t.closest("details").querySelector(".kname").textContent = t.value || "untitled.md";
      return markDirty();
    }
  });

  root.addEventListener("change", (ev) => {
    const t = ev.target;
    if (model && t.dataset.k === "enabled") {
      setPath(model.config, "enabled", t.checked);
      markDirty();
    }
    if (model && t.dataset.upload) uploadFiles(t.dataset.upload, [...t.files]);
  });

  // <details> toggle does not bubble: capture it.
  root.addEventListener(
    "toggle",
    (ev) => {
      const d = ev.target;
      if (model && d.dataset?.kidx !== undefined) model.knowledge[Number(d.dataset.kidx)].open = d.open;
    },
    true,
  );

  root.addEventListener("click", (ev) => {
    if (!model) return;
    const b = ev.target.closest("[data-act], [data-x]");
    if (!b) return;
    if (b.dataset.x === "connect") return connect(model.slug);
    if (b.dataset.x === "disconnect") return disconnect(model.slug);
    const act = b.dataset.act;
    if (act === "back") {
      if (!confirmLeave()) ev.preventDefault();
      else model.dirty = false;
      return;
    }
    if (act === "list-add") {
      const list = v(b.dataset.list) ?? [];
      list.push("");
      setPath(model.config, b.dataset.list, list);
    } else if (act === "list-del") {
      const list = v(b.dataset.list) ?? [];
      list.splice(Number(b.dataset.i), 1);
    } else if (act === "pillar-add") {
      v("pillars").push({ id: "", description: "", weight: 1 });
    } else if (act === "window-add") {
      v("cadence.windows").push("17:00-19:00");
    } else if (act === "font-up-del") {
      model.fontUploads.splice(Number(b.dataset.i), 1);
    } else if (act === "kadd") {
      const used = new Set(model.knowledge.map((k) => k.name));
      let n = (model.knowledge.length + 1) * 10;
      while (used.has(`${String(n).padStart(2, "0")}-notes.md`)) n += 10;
      model.knowledge.forEach((k) => (k.open = false));
      model.knowledge.push({ name: `${String(n).padStart(2, "0")}-notes.md`, content: "", isNew: true, open: true });
    } else if (act === "kdel") {
      const i = Number(b.dataset.i);
      const k = model.knowledge[i];
      if (!confirm(`Delete ${k.name}?${k.isNew ? "" : " The file is removed when you save."}`)) return;
      if (!k.isNew) model.knowledgeDelete.push(k.name);
      model.knowledge.splice(i, 1);
    } else return;
    dropErrorsUnder(b.dataset.list ?? (act.startsWith("k") ? "knowledge" : ""));
    markDirty();
    renderForm();
  });

  /** Row indexes shift after add/remove, so errors under that list no longer point at the right row. */
  function dropErrorsUnder(prefix) {
    if (!prefix) return;
    for (const k of Object.keys(model.errors)) if (k === prefix || k.startsWith(`${prefix}.`)) delete model.errors[k];
  }

  root.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!model) return;
    if (ev.target.dataset.actForm === "prefill") startPrefill();
    else save();
  });

  // ---------- uploads ----------

  async function uploadFiles(kind, files) {
    for (const file of files) {
      if (file.size > UPLOAD_MB[kind] * 1024 * 1024) {
        toast(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${UPLOAD_MB[kind]} MB.`, "error");
        continue;
      }
      model.uploading++;
      renderForm();
      try {
        const data = await readAsBase64(file);
        const up = await api("POST", "/api/uploads", { kind, name: file.name, data });
        if (!model) return;
        if (kind === "logo") {
          model.logo = { upload: up.token, url: up.url, name: up.name };
          delete model.errors["brand.logo"];
        } else if (kind === "font") {
          model.fontUploads.push({ token: up.token, name: up.name });
        } else {
          const key = kind === "screen" ? "screens" : "clips";
          const list = v(`assets.${key}`) ?? [];
          const taken = new Set(list.map((x) => x.id));
          let id = slugify(up.name.replace(/\.[a-z0-9]+$/, "")) || kind;
          for (let n = 2; taken.has(id); n++) id = `${slugify(up.name.replace(/\.[a-z0-9]+$/, ""))}-${n}`;
          list.push({ id, description: "", upload: up.token, _preview: up.url, _name: up.name });
          setPath(model.config, `assets.${key}`, list);
        }
        model.dirty = true;
      } catch (e) {
        toast(`${file.name}: ${e.message}`, "error");
      } finally {
        if (model) {
          model.uploading--;
          renderForm();
        }
      }
    }
  }

  // ---------- prefill ----------

  async function startPrefill() {
    const url = document.getElementById("pf-url")?.value.trim();
    if (!url) return toast("Enter the product's website first.", "error");
    try {
      const { job } = await api("POST", "/api/prefill", { url });
      model.prefill = { id: job.id, url, status: "running", step: job.step, error: null, notes: [], sources: [] };
      renderForm();
      clearInterval(prefillTimer);
      prefillTimer = setInterval(pollPrefill, 1200);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function pollPrefill() {
    const pf = model?.prefill;
    if (!pf || pf.status !== "running") return clearInterval(prefillTimer);
    let r;
    try {
      r = await api("GET", `/api/prefill/${pf.id}`);
    } catch (e) {
      clearInterval(prefillTimer);
      Object.assign(pf, { status: "failed", error: e.message });
      return renderForm();
    }
    if (model?.prefill !== pf) return;
    if (r.job.status === "running") {
      if (r.job.step !== pf.step) {
        pf.step = r.job.step;
        const el = document.querySelector(".pf-status");
        if (el) el.innerHTML = `<span class="spinner sm" aria-hidden="true"></span> ${esc(pf.step || "Working")}…`;
      }
      return;
    }
    clearInterval(prefillTimer);
    if (r.job.status === "failed" || !r.draft) {
      Object.assign(pf, { status: "failed", error: r.job.error });
      return renderForm();
    }
    const typed = model.dirty && (v("name") || v("one_liner") || model.knowledge.some((k) => k.content.trim()));
    if (typed && !confirm("Replace what you have typed with the draft from the website?")) {
      Object.assign(pf, { status: "failed", error: "Draft discarded: you kept your own text." });
      return renderForm();
    }
    const d = r.draft;
    model.config = withDefaults(defaults(), d.config);
    if (!model.slugTouched) model.slug = d.slug;
    model.knowledge = d.knowledge.map((k) => ({ ...k, isNew: true, open: true }));
    model.logo = d.logo_upload ? { upload: d.logo_upload, url: d.logo_url, name: "logo from the website" } : model.logo;
    model.errors = {};
    model.dirty = true;
    Object.assign(pf, { status: "done", notes: d.notes, sources: d.sources });
    renderForm();
    toast("Draft ready. Review it, then press Create account.", "ok");
  }

  // ---------- save ----------

  function payload() {
    const cfg = clone(model.config);
    for (const path of STRING_LISTS) {
      const list = getPath(cfg, path);
      if (Array.isArray(list)) setPath(cfg, path, list.map((s) => String(s ?? "").trim()).filter(Boolean));
    }
    for (const key of ["screens", "clips"]) {
      cfg.assets[key] = (cfg.assets[key] ?? []).map((it) => {
        const out = {};
        for (const [k, val] of Object.entries(it)) if (!k.startsWith("_") && val !== undefined && val !== "") out[k] = val;
        return out;
      });
    }
    cfg.cadence.windows = (cfg.cadence.windows ?? []).filter((w) => w && w !== "-");
    return {
      config: cfg,
      knowledge: model.knowledge.map(({ name, content }) => ({ name, content })),
      knowledge_delete: model.knowledgeDelete,
      logo_upload: model.logo?.upload ?? null,
      font_uploads: model.fontUploads.map((f) => f.token),
    };
  }

  async function save() {
    if (model.saving || model.uploading) return;
    const create = model.mode === "create";
    model.saving = true;
    model.errors = {};
    renderForm();
    let res;
    let data = {};
    try {
      res = await fetch(create ? "/api/products" : `/api/products/${encodeURIComponent(model.slug)}`, {
        method: create ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(create ? { slug: model.slug, ...payload() } : payload()),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      data = { error: e.message };
    }
    model.saving = false;
    if (!res?.ok) {
      model.errors = data.errors ?? {};
      renderForm();
      toast(data.error || "Could not save", "error");
      const first = document.querySelector("#account-root .has-error");
      first?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    model.dirty = false;
    for (const n of data.notes ?? []) toast(n, "info");
    toast(create ? `Account ${data.slug} created. Connect its X account next.` : "Saved.", "ok");
    await refresh();
    if (create) {
      select(data.slug, { toPosts: false });
      location.hash = `#account/${data.slug}`;
    } else {
      await openView(model.slug);
    }
  }

  return { renderSelector, renderXCard, openView, closeView, confirmLeave, isOpen, avatarHtml, connectJob };
}
