// Pure copy helpers for the Remotion compositions.
// Everything here is parsed in Node and injected as data, so the browser side never parses markup.
import type { VideoCopy } from "../core/types.ts";

export interface Segment {
  text: string;
  hl: boolean;
  /** Crossed out: the wrong answer next to the right one. */
  strike: boolean;
}

export interface Word {
  text: string;
  hl: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split copy into plain/highlighted/struck segments. `*word*` highlights and `~words~` strikes through;
 * words listed in `highlightWords` are highlighted too when they appear unmarked (whole word,
 * case-insensitive). Stray markers are dropped.
 */
export function parseHighlights(text: string, highlightWords: string[] = []): Segment[] {
  const out: Segment[] = [];
  const push = (t: string, hl: boolean, strike = false) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.hl === hl && last.strike === strike) last.text += t;
    else out.push({ text: t, hl, strike });
  };

  const marked: Segment[] = [];
  const re = /\*([^*\n]+)\*|~([^~\n]+)~/g;
  let idx = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    marked.push({ text: text.slice(idx, m.index), hl: false, strike: false });
    marked.push(m[1] != null ? { text: m[1], hl: true, strike: false } : { text: m[2] ?? "", hl: false, strike: true });
    idx = m.index + m[0].length;
  }
  marked.push({ text: text.slice(idx), hl: false, strike: false });

  const words = highlightWords.map((w) => w.trim()).filter(Boolean);
  const wordRe = words.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${words.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu")
    : null;

  for (const seg of marked) {
    const clean = seg.text.replace(/[*~]/g, "");
    if (seg.hl || seg.strike || !wordRe) {
      push(clean, seg.hl, seg.strike);
      continue;
    }
    let j = 0;
    for (const m of clean.matchAll(wordRe)) {
      push(clean.slice(j, m.index), false);
      push(m[0], true);
      j = (m.index ?? 0) + m[0].length;
    }
    push(clean.slice(j), false);
  }
  return out;
}

/** Segments to words (whitespace-separated), each keeping its highlight flag. */
export function toWords(segs: Segment[]): Word[] {
  const words: Word[] = [];
  let glue = false; // previous chunk ended mid-word (e.g. "*Right*," -> "Right" + ",")
  for (const s of segs) {
    const parts = s.text.split(/(\s+)/);
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) {
        glue = false;
        continue;
      }
      const last = words[words.length - 1];
      if (glue && last) {
        // Attach punctuation to the highlighted word without recoloring it.
        last.text += p;
      } else words.push({ text: p, hl: s.hl });
      glue = true;
    }
  }
  return words;
}

/** Hostname without www, e.g. https://www.example.com/x -> example.com */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

// ---------- Video beats ----------

export interface Beat {
  words: Word[];
  start: number;
  dur: number;
}

export interface BeatPlan {
  beats: Beat[];
  outro: { start: number; dur: number };
  total: number;
}

export interface BeatOptions {
  /** Hostname shown by the outro; a beat that only repeats it is dropped. */
  host?: string;
  minTotal?: number;
  maxTotal?: number;
  outro?: number;
  lead?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Reading time for one beat: entrance + ~3.3 words/s, clamped. */
export function beatSeconds(words: number): number {
  return Math.min(3.4, Math.max(1.6, 0.9 + words * 0.3));
}

/**
 * Turn headline + beats into sequential beats that fit in [minTotal, maxTotal] seconds including the outro.
 * Too short: beats stretch (up to 2x), then the outro absorbs the rest. Too long: beats compress down to
 * 1.2 s each, then trailing beats are dropped (the headline always stays).
 */
export function planBeats(vc: VideoCopy, opts: BeatOptions = {}): BeatPlan {
  const { host, minTotal = 6, maxTotal = 15, lead = 0.25 } = opts;
  let outro = opts.outro ?? 2.4;
  const norm = (s: string) => s.replace(/[*~]/g, "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const texts = [vc.headline, ...vc.beats].filter((t) => t.trim() && (!host || norm(t) !== norm(host)));
  let wordsList = texts.map((t) => toWords(parseHighlights(t, vc.highlight_words)));
  let durs = wordsList.map((w) => beatSeconds(w.length));

  const budget = maxTotal - outro - lead;
  let sum = durs.reduce((a, b) => a + b, 0);
  if (sum > budget) {
    const k = budget / sum;
    durs = durs.map((d) => Math.max(1.2, d * k));
    while (durs.reduce((a, b) => a + b, 0) > budget + 1e-6 && durs.length > 1) {
      durs.pop();
      wordsList = wordsList.slice(0, durs.length);
    }
    sum = durs.reduce((a, b) => a + b, 0);
    if (sum > budget) durs = durs.map((d) => (d * budget) / sum);
  }
  sum = durs.reduce((a, b) => a + b, 0);
  const minBeats = minTotal - outro - lead;
  if (sum < minBeats && sum > 0) {
    const k = Math.min(2, minBeats / sum);
    durs = durs.map((d) => d * k);
    sum = durs.reduce((a, b) => a + b, 0);
  }
  if (sum + outro + lead < minTotal) outro = minTotal - sum - lead;

  let t = lead;
  const beats = wordsList.map((words, i) => {
    const b = { words, start: round2(t), dur: round2(durs[i]!) };
    t += durs[i]!;
    return b;
  });
  const outroStart = round2(t);
  return { beats, outro: { start: outroStart, dur: round2(outro) }, total: round2(outroStart + outro) };
}
