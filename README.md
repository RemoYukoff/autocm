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

1. Create an app at developer.x.com with Read and Write permissions, and generate OAuth 1.0a user tokens for the product's account.
2. Put them in `products/<slug>/.env` (see `products/.env.example`). Check with `pnpm autocm x whoami <slug>`.

From then on, posts publish to X on schedule. Until the credentials exist, posts are still generated and shown in
the dashboard, but publishing is blocked by a guard (`no X credentials`); a blocked slot is skipped after 3 h.

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
