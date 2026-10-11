# autocm

Autonomous community manager for X. For every product in `products/<slug>/` a marketing agent decides each post
(what it is for, what kind of post, text, image or video), a copywriter writes it, a designer agent builds its image
or a motion-design agent cuts its video from scratch in the brand's style, and it publishes on a schedule.
No approval needed; a local dashboard lets you watch upcoming posts and veto them.

## How a post is made

1. **Marketer** (opus, `src/agents/marketer.ts`) reads the product knowledge, the marketing playbook
   (`src/agents/playbook.ts`: goals, plays, how X distributes posts), the last 30 posts with the engagement X reported,
   the ideas the owner discarded, and the goal/format/pillar mix. It returns a brief: goal (`reach`, `engagement`,
   `conversion`), play (hot take, relatable pain, story, how-to, teardown, list, question, product moment, offer...),
   the reader insight, angle, media kind (`none`, `design`, `video`) and, for images and videos, the visual concept
   (what it shows or the story beat by beat, the words on it, the aspect).
2. **Dedupe** rejects ideas already posted (trigram similarity + a haiku check) and re-plans.
3. **Copywriter** (opus) writes 3-4 versions of the tweet with different hooks and keeps the strongest (all are
   saved in `copy.json`).
4. **Media**: for images the **designer** (opus, `src/agents/designer.ts`) writes an HTML/CSS/SVG page from the
   concept, following the product's design manual (`brand.guidelines`) and a screenshot of its website. It renders
   it with a tool that returns the screenshot plus layout problems (text clipped, off the canvas, too small,
   overlapping, missing fonts), fixes what it sees, and picks the render to publish (up to 6 renders). It can also
   generate up to 2 photos or illustrations on ElevenLabs and place them in the page.
   For videos the **editor** (opus, `src/agents/editor.ts`) works the same way: it generates the raw material it
   needs on ElevenLabs (footage with Veo 3.1 Fast, pictures, a music bed), adds the product's own clips and
   screenshots if it wants, and writes a timeline (`src/media/edit.ts`) of animated HTML/CSS scenes in the brand's
   style, video layers and audio layers. A `preview` tool returns stills across it plus the layout problems of each
   scene; it fixes and previews again (up to 6), then Remotion renders the chosen timeline (`remotion/src/Edit.tsx`,
   CSS animations frozen to each frame so renders are exact).
5. **Hard checks**: only what X itself would refuse (≤280 weighted chars, media size/duration/codec).
   A tweet that is too long is rewritten up to 2 times. There is no LLM review.
6. **Publisher**: guards (pause, daily caps, min gap, duplicates, X connected), then the post goes out through the product's logged-in browser profile. There is no dry-run and no X API.

LLM calls run through the Claude Agent SDK on your Claude Code subscription (`src/llm.ts`), with your own
settings, hooks, plugins and MCP servers disabled for those calls.

Images, video and music are generated on **ElevenLabs** through its MCP server (`src/media/elevenlabs.ts`), using
the OAuth login of the user-scope `elevenlabs` MCP in Claude Code (no API key in `.env`). Log in once from Claude
Code (`/mcp`, elevenlabs, authenticate); if the login expires, generations fail with that error until you log in
again. A small agent runs a fixed recipe while the code pins model and parameters and allows one charged generation
per job. Measured cost: a 2K image ~470 credits, a 15 s music track ~410, an 8 s 1080p Veo clip ~7,270.
Per post the designer may make 2 images; the editor 4 images, 2 clips and 1 music track.

## Quick start

```sh
pnpm install
cp .env.example .env
pnpm autocm products validate
pnpm autocm run --dashboard              # plan, write and publish on schedule; veto at http://127.0.0.1:4321
```

Generated artifacts land in `out/<product>/<date>/<postId>/` (brief, copy versions, media, the designer's renders, frames).

## Running on a schedule

```sh
pnpm autocm plan -d 2    # create posting slots inside each product's windows (they are due for writing at once)
pnpm autocm tick         # one pass: write due slots, publish due posts
pnpm autocm run          # daemon: tick every 5 min, plan daily, read post metrics every 2 h
```

### Always-on local service

`deploy/autocm.service` runs `run --dashboard --watch` from this checkout as a systemd user service, so the
dashboard is always at http://127.0.0.1:4321 and survives reboots (linger is on).

```sh
ln -sf ~/repos/autocm/deploy/autocm.service ~/.config/systemd/user/autocm.service
systemctl --user daemon-reload && systemctl --user enable --now autocm
journalctl --user -u autocm -f            # logs
systemctl --user restart autocm           # manual restart; stop/start the same way
```

Edits apply without touching the service:
- `products/**`, `src/dashboard/public/**`: read on every use, so the next post or page reload uses them.
- `src/**`, `remotion/src/**`, `.env`, `package.json`, `pnpm-lock.yaml`: `--watch` sees the change, waits until no
  tick or dashboard job is running, then exits; systemd restarts it with the new code a couple of seconds later.
  Run `pnpm install` before a dependency change lands.

## Dashboard

```sh
pnpm autocm run --dashboard     # scheduler + dashboard in one process (recommended)
pnpm autocm dashboard           # dashboard only, http://127.0.0.1:4321
```

Shows only what the bot is about to publish: each planned slot with an X-style preview of its post (text, image
or video). Every day the scheduler picks how many posts to make (`cadence.posts_per_day_min` to `posts_per_day_max`)
and when, and writes them right away, so they are visible hours before they go out. The actions are discard
(veto), changing a post's time (click the time), **+ Generate post** (one more post at a free time in the posting
windows, under the daily cap; written right away) and pause/resume of the shown account. Without a veto, posts publish on schedule.
Each post shows its goal and play (the angle on hover) and, once published, the views, likes, replies, reposts and
bookmarks read back from X. A discarded post is remembered as a veto: the marketer stays away from that idea.

### Accounts

The dashboard always shows one account: the last one opened in this browser, else the first. The account menu in
the header switches between them; with no accounts the menu is just **+ Add account**. Each account has its own
pause switch; it only stops publishing (posts are still written; a post more than 3 h past its time while paused is skipped). Adding an account takes two steps and exposes no product settings:

1. **+ Add account** opens a browser window at x.com/login. Log in to the X account autocm should post from; the
   window closes by itself and the account appears under its @handle (its slug comes from the handle).
2. The account then asks for **the product's website**. autocm reads the homepage and up to 4 relevant pages
   (pricing, features, about, docs) in headless Chromium, picks the logo and brand colors, screenshots the homepage
   (the designer's visual reference), asks the LLM (stage `product-draft`, it sees the screenshot) for everything else
   (voice, pillars, format mix, design manual, knowledge ending in "Facts you must not claim"), fills any gap with defaults, writes `products/<slug>/` and plans posts at once. If the site can't be
   read, the account keeps asking for a website.

The rest of the menu: **Reconnect** when a session breaks (it must be the same X account), **Delete** to remove an
account with its session, product folder, generated files and planned posts.

## Connecting X

autocm does not use the X API. Each product posts, reads its profile and reads its posts' engagement through its own
logged-in browser profile in `data/sessions/<slug>/`, driven by Playwright's full Chromium build: headed for
the login, headless afterwards, with the same user agent in both so X sees one browser.

1. **+ Add account** in the dashboard opens a Chromium window at x.com/login; log in (2FA is fine) within 10 min and
   it closes by itself. Handle, display name and avatar are saved; closing the window cancels and leaves nothing
   behind. Then give the account its product's website (see "Accounts" above).
2. If a session breaks (logged out, locked), the account shows **Reconnect**. From the CLI, with the service stopped
   (a browser profile can only be open in one process): `pnpm autocm x connect <slug>`, and `pnpm autocm x whoami <slug>`
   to check it.
3. **Delete account** removes the product folder, its X session, generated files and every planned post.

- `data/sessions/` holds the X session cookies. It is gitignored: never commit, copy or share it.
- A logged-out, locked or challenged session pauses that account and shows the error on the account; reconnect.
- A failed post saves a screenshot in `out/x-debug/<slug>/` (never the page HTML). A failure after the Post click
  is never retried, because the post may be live: check the account on X before re-posting.
- The X selectors and GraphQL response shapes live in `src/x/selectors.ts`. They have not been verified against
  live X; when X changes its web app, fix them there.

## Safety rails

- Kill switch per account: Pause/Resume in the dashboard, or `pnpm autocm pause <product>` / `resume <product>`.
- Per-product `daily_cap`, global `AUTOCM_GLOBAL_DAILY_CAP`, `min_gap_min` between posts.
- Exact and near-duplicate check right before publishing.
- An account auto-pauses after 3 consecutive publish failures or when its X session is logged out or locked.
- Never re-posts blindly after a crash: posts stuck in `publishing` are marked failed.

## Adding a product

Only from the dashboard: **+ Add account** (X login), then the product's website (see "Accounts"). `docs/products.md` documents the folder autocm writes. `products/` is local only (gitignored).

## Development

`pnpm typecheck`, `pnpm autocm render-fixture fixtures/media/<file>.json` (fixtures are local, gitignored; a `design`
fixture runs the designer agent),
`pnpm tsx scripts/llm-smoke.ts`.
