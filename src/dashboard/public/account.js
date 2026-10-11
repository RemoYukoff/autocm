// Accounts: the selector menu and the two-step add flow (log in to X, then give the product's website).
// Exactly one account is shown at a time: the remembered one, else the first. With none, the selector is "Add account".
// No product settings are shown or editable: autocm builds them from the website. Vanilla JS, no build step.

const LS_KEY = "autocm.account";

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

/** The account to show: the remembered one if it still exists, else the first; null when there are none. */
export function pickSelected(products, current) {
  const slug = products.some((p) => p.slug === current) ? current : (products[0]?.slug ?? null);
  if (slug !== current) saveSelected(slug);
  return slug;
}

export function createAccounts(ctx) {
  const { $, esc, api, toast, refresh, state, ask } = ctx;

  const products = () => state.data?.products ?? [];
  const jobs = () => state.data?.account_jobs ?? [];
  const jobFor = (slug) => jobs().find((j) => j.product === slug && j.status === "running");
  const addJob = () => jobs().find((j) => j.kind === "add" && j.status === "running");

  function avatarHtml(p, cls = "av") {
    if (p?.x?.avatar_url) return `<img class="${cls}" src="${esc(p.x.avatar_url)}" alt="" loading="lazy">`;
    const initial = (p?.name || p?.slug || "?").trim().charAt(0).toUpperCase();
    return `<span class="${cls}" style="--av:${esc(p?.color || "#5f6873")}" aria-hidden="true">${esc(initial)}</span>`;
  }

  function select(slug) {
    state.selected = slug;
    saveSelected(slug);
    closeMenu();
    refresh();
  }

  // ---------- selector ----------

  function subline(p) {
    const job = jobFor(p.slug);
    if (job) return `<span class="acct-sub busy">${esc(job.step || "working…")}</span>`;
    if (p.invalid) return `<span class="acct-sub err">settings broken; delete and add it again</span>`;
    if (p.setup === "website") return `<span class="acct-sub warn">@${esc(p.handle)} · needs its website</span>`;
    if (p.x?.error) return `<span class="acct-sub err">@${esc(p.x.handle)} · session problem</span>`;
    if (!p.x) return `<span class="acct-sub err">X session missing</span>`;
    return `<span class="acct-sub">@${esc(p.x.handle)}</span>`;
  }

  const PAUSE_MARK = `<span class="pause-mark" aria-hidden="true"><i></i><i></i></span>`;

  /** A paused account: a yellow line at the bottom of the row, after whatever else it says. */
  function pausedLine(p) {
    return p.paused ? `<span class="acct-paused">${PAUSE_MARK}Paused · not publishing</span>` : "";
  }

  const ADD_ITEM = `<span class="av av-plus" aria-hidden="true">+</span><span class="acct-text"><span class="acct-name">Add account</span><span class="acct-sub">Log in to an X account</span></span>`;

  function addingHtml(job) {
    return `<span class="spinner sm" aria-hidden="true"></span><span class="acct-text"><span class="acct-name">Adding an account</span><span class="acct-sub busy">${esc(job.step || "Log in to X in the window that opened")}</span></span>`;
  }

  function renderSelector() {
    const list = products();
    const cur = list.find((p) => p.slug === state.selected);
    const btn = $("#acct-btn");
    const adding = addJob();
    if (!cur) {
      // No accounts yet: the selector itself adds one.
      closeMenu();
      btn.dataset.add = "1";
      btn.classList.remove("paused");
      btn.removeAttribute("aria-haspopup");
      btn.title = "Log in to an X account";
      btn.disabled = !!adding;
      btn.innerHTML = adding ? addingHtml(adding) : ADD_ITEM;
      const big = $("[data-add-account]");
      big.disabled = !!adding;
      big.textContent = adding ? "Log in to X in the window that opened…" : "+ Add account";
      return;
    }
    delete btn.dataset.add;
    btn.classList.toggle("paused", !!cur.paused);
    btn.title = cur.paused ? "Publishing paused for this account" : "Choose the account to show";
    btn.setAttribute("aria-haspopup", "menu");
    btn.disabled = false;
    btn.innerHTML = `${avatarHtml(cur)}<span class="acct-label"><span class="acct-name">${esc(cur.name)}</span>${cur.handle ? `<span class="acct-handle">@${esc(cur.handle)}</span>` : ""}</span><span class="caret" aria-hidden="true"></span>`;

    const rows = list
      .map((p) => {
        const tools = [];
        if (!jobFor(p.slug)) {
          if (p.paused) tools.push(`<button type="button" class="mini mini-resume" data-acct-resume="${esc(p.slug)}" aria-label="Resume publishing for ${esc(p.name)}">Resume</button>`);
          if (!p.invalid && (!p.x || p.x.error)) tools.push(`<button type="button" class="mini mini-warn" data-acct-reconnect="${esc(p.slug)}">Reconnect</button>`);
          tools.push(`<button type="button" class="mini" data-acct-delete="${esc(p.slug)}" aria-label="Delete ${esc(p.name)}">Delete</button>`);
        }
        return `<div class="acct-row${p.enabled || p.setup === "website" ? "" : " off"}${p.paused ? " paused" : ""}">
          <button type="button" class="acct-item" role="menuitemradio" aria-checked="${p.slug === state.selected}" data-acct-select="${esc(p.slug)}">
            ${avatarHtml(p)}<span class="acct-text"><span class="acct-name">${esc(p.name)}</span>${subline(p)}${pausedLine(p)}</span>
          </button>
          <div class="acct-tools">${tools.join("")}</div>
        </div>`;
      })
      .join("");
    $("#acct-menu").innerHTML = `
      ${rows}
      <div class="acct-sep" role="separator"></div>
      ${adding ? `<div class="acct-item acct-add">${addingHtml(adding)}</div>` : `<button type="button" class="acct-item acct-add" role="menuitem" data-acct-add>${ADD_ITEM}</button>`}`;
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
    if ($("#acct-btn").dataset.add) add();
    else if ($("#acct-menu").hidden) openMenu();
    else closeMenu();
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#acct")) closeMenu();
    if (ev.target.closest("[data-add-account]")) add();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("#acct-menu").hidden) {
      closeMenu();
      $("#acct-btn").focus();
    }
  });
  $("#acct-menu").addEventListener("click", (ev) => {
    const sel = ev.target.closest("[data-acct-select]");
    const del = ev.target.closest("[data-acct-delete]");
    const rec = ev.target.closest("[data-acct-reconnect]");
    const res = ev.target.closest("[data-acct-resume]");
    if (sel) return select(sel.dataset.acctSelect);
    closeMenu();
    if (res) resume(res.dataset.acctResume);
    else if (del) remove(del.dataset.acctDelete);
    else if (rec) reconnect(rec.dataset.acctReconnect);
    else if (ev.target.closest("[data-acct-add]")) add();
  });

  // ---------- actions ----------

  async function add() {
    if (!(await ask({ title: "Add an X account", body: "A browser window opens on this computer. Log in there to the X account autocm should post from; it closes by itself once you are in.", ok: "Open X login" }))) return;
    try {
      await api("POST", "/api/accounts");
      toast("Log in to X in the window that opened.", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
    await refresh();
  }

  async function reconnect(slug) {
    const p = products().find((x) => x.slug === slug);
    if (!(await ask({ title: `Reconnect @${p?.handle ?? slug}`, body: `A browser window opens. Log in there as @${p?.handle ?? slug}; it closes by itself once you are in.`, ok: "Open X login" }))) return;
    try {
      await api("POST", `/api/accounts/${encodeURIComponent(slug)}/reconnect`);
      toast(`Log in as @${p?.handle ?? slug} in the window that opened.`, "ok");
    } catch (e) {
      toast(e.message, "error");
    }
    await refresh();
  }

  async function resume(slug) {
    const p = products().find((x) => x.slug === slug);
    try {
      await api("POST", `/api/accounts/${encodeURIComponent(slug)}/resume`);
      toast(`Publishing resumed for ${p?.name ?? slug}.`, "ok");
    } catch (e) {
      toast(e.message, "error");
    }
    await refresh();
  }

  async function remove(slug) {
    const p = products().find((x) => x.slug === slug);
    const who = p?.handle ? `@${p.handle}` : (p?.name ?? slug);
    if (!(await ask({ title: `Delete ${who}?`, body: "Its X session and every planned post are removed. This cannot be undone.", ok: "Delete", danger: true }))) return;
    try {
      await api("POST", `/api/accounts/${encodeURIComponent(slug)}/delete`);
      toast(`${who} deleted.`, "ok");
      if (state.selected === slug) select(null); // the next refresh shows the first remaining account
    } catch (e) {
      toast(e.message, "error");
    }
    await refresh();
  }

  async function setWebsite(slug, url) {
    try {
      await api("POST", `/api/accounts/${encodeURIComponent(slug)}/website`, { url });
    } catch (e) {
      toast(e.message, "error");
    }
    await refresh();
  }

  // ---------- setup cards: accounts waiting for their website ----------

  /** Typed URLs survive re-renders (the state refreshes every few seconds). */
  const typed = new Map();

  function setupCard(p) {
    const job = jobFor(p.slug);
    const failed = jobs().find((j) => j.kind === "website" && j.product === p.slug);
    let body;
    if (job) {
      body = `<div class="setup-busy"><span class="spinner" aria-hidden="true"></span><div><strong>Setting up @${esc(p.handle)}</strong><p class="muted small">${esc(job.step || "Reading the website")}…</p></div></div>`;
    } else {
      body = `<p>Logged in as <strong>@${esc(p.handle)}</strong>. What is the website of the product it posts about?</p>
        ${failed?.status === "failed" ? `<p class="warn">${esc(failed.error ?? "Could not read that website")}</p>` : ""}
        <form class="setup-row" data-setup="${esc(p.slug)}">
          <input type="url" name="url" required placeholder="https://yourproduct.com" value="${esc(typed.get(p.slug) ?? "")}" aria-label="Product website for @${esc(p.handle)}">
          <button type="submit" class="btn btn-primary">Set up</button>
        </form>`;
    }
    return `<div class="setup-card" data-key="setup-${esc(p.slug)}">${avatarHtml(p, "av av-lg")}<div class="setup-body">${body}</div></div>`;
  }

  function renderSetup() {
    const el = $("#setup");
    const focused = document.activeElement?.closest?.("[data-setup]")?.dataset.setup;
    const pending = products().filter((p) => p.setup === "website" && p.slug === state.selected);
    el.innerHTML = pending.map(setupCard).join("");
    el.hidden = pending.length === 0;
    if (focused) el.querySelector(`[data-setup="${CSS.escape(focused)}"] input`)?.focus();
  }

  $("#setup").addEventListener("input", (ev) => {
    const form = ev.target.closest("[data-setup]");
    if (form) typed.set(form.dataset.setup, ev.target.value);
  });
  $("#setup").addEventListener("submit", (ev) => {
    const form = ev.target.closest("[data-setup]");
    if (!form) return;
    ev.preventDefault();
    const url = new FormData(form).get("url");
    typed.delete(form.dataset.setup);
    setWebsite(form.dataset.setup, String(url ?? "").trim());
  });

  /** Toast when a job this page saw running has finished. */
  function jobFinished(j) {
    const p = products().find((x) => x.slug === j.product);
    const who = p?.handle ? `@${p.handle}` : (j.product ?? "account");
    if (j.status === "failed") {
      if (j.kind !== "website") toast(`${j.kind === "add" ? "Adding the account" : `Reconnecting ${who}`} failed: ${j.error ?? "unknown error"}`, "error");
      return;
    }
    if (j.kind === "add") {
      toast(`${who} added. Now give it its product's website.`, "ok");
      if (j.product) select(j.product);
    } else if (j.kind === "website") toast(`${who} is set up and will start posting.`, "ok");
    else toast(`${who} reconnected.`, "ok");
  }

  return { renderSelector, renderSetup, avatarHtml, jobFinished };
}
