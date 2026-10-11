// The marketing playbook every product shares: what each goal and play is for, how X distributes posts, and how
// hooks are written. The marketer and the copywriter both read it; product.yaml only says who the product is.
import type { Goal, Play } from "../core/types.ts";

/** Share of posts per goal the marketer steers toward over two weeks. Promotion stays the minority. */
export const GOAL_TARGET: Record<Goal, number> = { reach: 0.45, engagement: 0.35, conversion: 0.2 };

export const GOAL_GUIDE: Record<Goal, string> = {
  reach:
    "get the post shown to people who do not follow the account yet: relatable, shareable, opinionated. Written about the " +
    "reader's world, not about the product; the product may be absent or a light touch. Never a link.",
  engagement:
    "make followers reply, bookmark or quote: a question they have an opinion on, a practical tip worth saving, a take " +
    "they want to argue with. The product is optional. Never a link.",
  conversion:
    "make the right reader want to try the product: one concrete thing it does, shown or told so the reader sees " +
    "themselves using it, ending in a clear, low-pressure invitation. The only goal that may carry a link.",
};

export const PLAY_GUIDE: Record<Play, string> = {
  hot_take: "a confident opinion the audience half-agrees with and will argue about. One sentence of claim, then the why.",
  relatable_pain: "the exact moment everyone in the audience has lived, told with dry humor. Specific beats generic.",
  story: "a tiny narrative: situation, what went wrong, the lesson. Past tense, concrete details, no moral lecture.",
  how_to: "one practical technique the reader can use today, with a concrete example. Save-worthy.",
  teardown: "take a realistic artifact (a ticket, a test case, a spec line) and show precisely what is wrong with it.",
  myth_vs_reality: "a common belief in the field, then what actually happens. Contrast does the work.",
  list: "3-5 tight items under one promise (e.g. edge cases people miss). Each item concrete; the post is worth bookmarking.",
  question: "a real question to the audience that is easy and fun to answer from experience. Invites replies, not likes.",
  product_moment: "one specific thing the product does, shown in a real situation (before/after, the moment it helps).",
  offer: "a direct, honest invitation: what you get, what it costs or that there is a trial, and where to go.",
};

/** How X ranks and shows posts, as it matters for a small account. */
export const X_RULES = [
  "Replies, reposts, quotes and bookmarks count far more than likes; a post people answer travels further.",
  "Posts with an external link get much less reach; keep links to conversion posts only.",
  "The first line decides whether anyone reads the rest: it shows alone in the feed before attention moves on.",
  "Images and short videos stop the scroll when they carry an idea of their own (a joke, a contrast, an artifact), not when they repeat the text.",
  "Hashtags and emoji make B2B posts look like ads; skip them.",
  "A small account grows by being specific and useful to a narrow audience, not by broad slogans.",
];

/** Hook techniques the copywriter draws from (one per variant). */
export const HOOKS = [
  "specific scene: open in the middle of a moment the reader knows (\"Friday, 5:40pm. The ticket says 'should work like before'.\")",
  "contrarian claim: say the opposite of the common advice, then back it",
  "number or concrete detail: a precise figure, field or rule instead of a generalization",
  "naming the unspoken: put words to what the audience thinks but nobody says",
  "before/after or expectation/reality in two short lines",
  "a question they can't help answering",
];

export const COPY_RULES = [
  "Write for one reader on their phone. Short lines, plain words, one idea.",
  "The hook is the first line, under ~70 characters, and must work on its own.",
  "Concrete beats clever: a real field, step, edge case or number from the knowledge base.",
  "Show, then say: the example first, the conclusion after (or never).",
  "No throat-clearing (\"Here's the thing\", \"Let's talk about\"), no hype, no rhetorical triple lists, no hashtags or emoji.",
  "End with energy: a punchline, a sharp question or a clear next step, not a summary.",
];
