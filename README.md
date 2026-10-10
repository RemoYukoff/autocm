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
6. **Publisher**: guards (pause, daily caps, min gap, duplicates), X credentials, then X API v2. There is no dry-run: every publish goes to X.

LLM calls run through the Claude Agent SDK on your Claude Code subscription (`src/llm.ts`), with your own
settings, hooks, plugins and MCP servers disabled for those calls.

## Quick start

```sh
pnpm install
cp .env.example .env
pnpm autocm products validate
pnpm autocm generate acme              # one post, format chosen by the strategist
pnpm autocm generate acme -f video     # force a format
pnpm autocm history acme
```

Generated artifacts land in `out/<product>/<date>/<postId>/` (brief, draft, media, frames, preview).

## Running on a schedule

```sh
pnpm autocm plan -d 2    # create posting slots inside each product's windows
pnpm autocm tick         # one pass: generate due slots (cadence.generate_lead_min before, default 3 h), publish due posts
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

Shows upcoming slots with an X-style preview of each generated post (text, image or video), ready posts and
history. Actions: discard (veto), skip a slot, regenerate (optionally forcing a format), publish now (guards
still apply), generate a new post, pause/resume. Without a veto, posts publish on schedule. Posts are generated
`cadence.generate_lead_min` (default 180) minutes before their slot, which is the review window.

## Connecting X

autocm does not use the X API. Each product posts, reads its profile and reads post metrics through its own
logged-in browser profile in `data/sessions/<slug>/`, driven by Playwright's full Chromium build: headed for
the login, headless afterwards, with the same user agent in both so X sees one browser.

1. Connect the account, either from the dashboard or from the CLI **with the service stopped** (a browser profile
   can only be open in one process, and the daemon uses it):

   ```sh
   systemctl --user stop autocm
   pnpm autocm x connect <slug>    # a Chromium window opens at x.com/login: log in (2FA is fine) within 10 min
   systemctl --user start autocm
   ```

   The window closes by itself once you are logged in. The handle, display name and avatar are saved (the avatar
   goes to `products/<slug>/assets/x-profile-avatar.<ext>`). Closing the window before logging in cancels.
2. Check it: `pnpm autocm x whoami <slug>` (service stopped, same reason). `pnpm autocm x metrics -d 7` reads
   likes, reposts, replies, quotes, bookmarks and views of recent posts; the daemon does this every 6 h.
3. To switch accounts or log out, disconnect from the dashboard: it deletes the profile and the account row.

From then on, posts publish to X on schedule. Until an account is connected, posts are still generated and shown
in the dashboard, but publishing is blocked by a guard (`X not connected`); a blocked slot is skipped after 3 h.

- `data/sessions/` holds the X session cookies. It is gitignored: never commit, copy or share it.
- A logged-out, locked or challenged session pauses publishing and shows the error on the account; reconnect.
- A failed post saves a screenshot in `out/x-debug/<slug>/` (never the page HTML). A failure after the Post click
  is never retried, because the post may be live: check the account on X before re-posting.
- The X selectors and GraphQL response shapes live in `src/x/selectors.ts`. They have not been verified against
  live X; when X changes its web app, fix them there.

## Safety rails

- Kill switch: `pnpm autocm pause [reason]` / `resume`, `AUTOCM_PAUSED=1`, or a `data/PAUSE` file.
- Per-product `daily_cap`, global `AUTOCM_GLOBAL_DAILY_CAP`, `min_gap_min` between posts.
- Exact and near-duplicate check right before publishing.
- Auto-pause after 3 consecutive publish failures or any X 401/403.
- Never re-posts blindly after a crash: posts stuck in `publishing` are marked failed.

## Adding a product

See `products/README.md`. A product is a folder: `product.yaml`, `knowledge/*.md`, `assets/`, and an optional `.env` with its X credentials.

## Development

`pnpm typecheck`, `pnpm test` (vitest, uses `AUTOCM_LLM=fake`), `pnpm autocm render-fixture fixtures/media/<file>.json`,
`pnpm tsx scripts/llm-smoke.ts [image]`.
