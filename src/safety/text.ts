// Text helpers shared by guards (publish-time dedupe) and the agents stream (generation-time dedupe).
import crypto from "node:crypto";

/** Lowercase, strip accents, URLs, punctuation (keeps #@$%) and extra whitespace. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}#@$%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable hash of the normalized text (sha256 hex). Use for posts.text_hash. */
export function textHash(text: string): string {
  return crypto.createHash("sha256").update(normalizeText(text)).digest("hex");
}

/** Character trigrams of the normalized text (padded so short words still produce grams). */
export function trigrams(text: string): Set<string> {
  const s = ` ${normalizeText(text)} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) grams.add(s.slice(i, i + 3));
  return grams;
}

/** Jaccard similarity of two trigram sets, 0..1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Trigram Jaccard similarity of two texts, 0..1. */
export function trigramSimilarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

export const NEAR_DUPLICATE_THRESHOLD = 0.8;

/** First candidate that is an exact (hash) or near (trigram Jaccard >= threshold) duplicate of `text`. */
export function findDuplicate<T extends { text: string | null; text_hash?: string | null }>(
  text: string,
  candidates: T[],
  threshold = NEAR_DUPLICATE_THRESHOLD,
): { match: T; similarity: number; exact: boolean } | null {
  const hash = textHash(text);
  const grams = trigrams(text);
  for (const c of candidates) {
    if (!c.text) continue;
    if (c.text_hash === hash || textHash(c.text) === hash) return { match: c, similarity: 1, exact: true };
    const sim = jaccard(grams, trigrams(c.text));
    if (sim >= threshold) return { match: c, similarity: sim, exact: false };
  }
  return null;
}
