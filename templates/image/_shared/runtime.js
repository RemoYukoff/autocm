// Shared runtime for image templates. The renderer injects window.__DATA__ (see src/media/image.ts),
// each template fills its own body, then calls finish() which fits the copy and flags window.__ready.
import { fitScale, overflows } from "./fit.js";

export const D = window.__DATA__;
export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Render [{text, hl}] segments; highlighted runs become <em class="hl">. */
export function segs(node, segments) {
  node.textContent = "";
  for (const s of segments || []) {
    if (s.hl) node.append(el("em", "hl", s.text));
    else node.append(document.createTextNode(s.text));
  }
  return node;
}

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CROSS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
export const icons = { check: CHECK, cross: CROSS };

/** Canvas size, theme, backdrop, eyebrow and footer around the template's #body. */
export function frame() {
  const root = document.documentElement;
  root.style.setProperty("--w", `${D.size.w}px`);
  root.style.setProperty("--h", `${D.size.h}px`);
  document.body.classList.add(D.size.w >= D.size.h ? "landscape" : "portrait", `theme-${D.theme}`);

  const card = $("#card");
  const bg = el("div", "bg");
  bg.append(el("div", "glow"), el("div", "dots"));
  if (D.background) {
    const img = el("img", "bg-image");
    img.src = D.background;
    const scrim = el("div", "scrim");
    bg.prepend(img, scrim);
    card.classList.add("has-image");
  }
  card.prepend(bg);

  if (D.eyebrow) {
    const top = el("header", "top");
    const eb = el("span", "eyebrow");
    eb.append(el("i", "sq"), el("span", null, D.eyebrow));
    top.append(eb);
    $("#body").before(top);
  }

  const foot = el("footer", "foot");
  const brand = el("div", "brand");
  if (D.brand.logo) {
    const logo = el("img", "logo");
    logo.src = D.brand.logo;
    logo.alt = "";
    brand.append(logo);
  }
  brand.append(el("span", "name", D.brand.name));
  foot.append(brand, el("span", "url", D.brand.host));
  card.append(foot);
}

async function loadFonts() {
  await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
  await document.fonts.ready;
}

const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/**
 * Shrink `--s` on each target until its region stops overflowing. Targets are fitted in order, so a later
 * target (e.g. a list) sees the space left by an earlier one. Below `min` it keeps shrinking to `floor`
 * rather than clip, and reports overflow if even that fails.
 */
export function fitAll(targets) {
  const results = [];
  for (const t of targets) {
    const host = t.scaleEl || t.region;
    const set = (s) => {
      host.style.setProperty("--s", String(s));
      void t.region.offsetHeight;
    };
    const fits = (s) => {
      set(s);
      return !overflows(t.region) && !(t.extra || []).some((x) => overflows(x));
    };
    let r = fitScale(fits, { min: t.min ?? 0.45, max: t.max ?? 1 });
    if (!r.ok) r = fitScale(fits, { min: t.floor ?? 0.2, max: t.min ?? 0.45 });
    set(r.scale);
    results.push({ name: t.name, scale: Number(r.scale.toFixed(3)), ok: r.ok });
  }
  return results;
}

export async function finish(targets) {
  await loadFonts();
  const fit = fitAll(targets());
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
  await loadFonts();
  await raf2();
  window.__report = {
    fit,
    fonts: [...document.fonts].map((f) => ({ family: f.family, weight: f.weight, status: f.status })),
    images: [...document.images].map((i) => ({ src: i.src.slice(0, 60), ok: i.complete && i.naturalWidth > 0 })),
  };
  window.__ready = true;
}

window.addEventListener("error", (e) => {
  window.__error = String(e.message || e);
});
