# autocm

Autonomous community manager for X. For every product in `products/<slug>/` it plans each post, picks the
format on its own (text, branded image, or video), writes it, renders the media and publishes on a schedule.
No approval needed; a local dashboard lets you watch upcoming posts and veto them.

## How a post is made

1. **Strategist** (sonnet) reads the product knowledge, the last 30 posts and the format/pillar deficit, and
   returns a brief: pillar, angle, format and media kind (`none`, `template`, `remotion`, `clip`, `ai_image`, `ai_video`).
2. **Dedupe** rejects ideas already posted (trigram similarity + a haiku check) and re-plans.
3. **Copywriter** (sonnet) writes the tweet (≤280 weighted chars), alt text and the copy for the visual.
4. **Media**: HTML templates rendered with Playwright (statement, comparison, stat, checklist, screenshot),
   Remotion kinetic-typography videos, or real product clips with a title card and end card.
   AI image/video providers are used only when keys are set, with fallback to templates/Remotion.
5. **Hard checks**: only what X itself would refuse (≤280 weighted chars, media size/duration/codec).
   A tweet that is too long is rewritten up to 2 times. There is no LLM review.
6. **Publisher**: guards (pause, daily caps, min gap, duplicates, X connected), then the post goes out through the product's logged-in browser profile. There is no dry-run and no X API.

LLM calls run through the Claude Agent SDK on your Claude Code subscription (`src/llm.ts`), with your own
settings, hooks, plugins and MCP servers disabled for those calls.

## Quick start

```sh
pnpm install
cp .env.example .env
pnpm autocm products validate
pnpm autocm run --dashboard              # plan, write and publish on schedule; veto at http://127.0.0.1:4321
```

Generated artifacts land in `out/<product>/<date>/<postId>/` (brief, draft, media, frames, preview).

## Running on a schedule

```sh
pnpm autocm plan -d 2    # create posting slots inside each product's windows (they are due for writing at once)
pnpm autocm tick         # one pass: write due slots, publish due posts
pnpm autocm run          # daemon: tick every 5 min, plan daily
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
- `products/**`, `templates/**`, `src/dashboard/public/**`: read on every use, so the next post or page reload uses them.
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
and when, and writes them right away, so they are visible hours before they go out. The only actions are
discard (veto) and pause/resume of the shown account. Without a veto, posts publish on schedule. Once published, a post leaves the
list; nothing tracks it afterwards.

### Accounts

The dashboard always shows one account: the last one opened in this browser, else the first. The account menu in
the header switches between them; with no accounts the menu is just **+ Add account**. Each account has its own
pause switch. Adding an account takes two steps and exposes no product settings:

1. **+ Add account** opens a browser window at x.com/login. Log in to the X account autocm should post from; the
   window closes by itself and the account appears under its @handle (its slug comes from the handle).
2. The account then asks for **the product's website**. autocm reads the homepage and up to 4 relevant pages
   (pricing, features, about, docs) in headless Chromium, picks the logo and brand colors, asks the LLM (stage
   `product-draft`) for everything else (voice, pillars, format mix, knowledge ending in "Facts you must not
   claim"), fills any gap with defaults, writes `products/<slug>/` and plans posts at once. If the site can't be
   read, the account keeps asking for a website.

The rest of the menu: **Reconnect** when a session breaks (it must be the same X account), **Delete** to remove an
account with its session, product folder, generated files and planned posts.

## Connecting X

autocm does not use the X API. Each product posts and reads its profile through its own
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

Only from the dashboard: **+ Add account** (X login), then the product's website (see "Accounts"). `products/README.md` documents the folder autocm writes.

## Development

`pnpm typecheck`, `pnpm test` (vitest, uses `AUTOCM_LLM=fake`), `pnpm autocm render-fixture fixtures/media/<file>.json`,
`pnpm tsx scripts/llm-smoke.ts`.
