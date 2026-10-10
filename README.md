# autocm

Autonomous community manager for X. For every product in `products/<slug>/` it plans each post, picks the
format on its own (text, branded image, or video), writes it, renders the media, runs a strict QA pass and
publishes on a schedule. No human approval; safety rails instead.

## How a post is made

1. **Strategist** (sonnet) reads the product knowledge, the last 30 posts and the format/pillar deficit, and
   returns a brief: pillar, angle, format and media kind (`none`, `template`, `remotion`, `clip`, `ai_image`, `ai_video`).
2. **Dedupe** rejects ideas already posted (trigram similarity + a haiku check) and re-plans.
3. **Copywriter** (sonnet) writes the tweet (≤280 weighted chars), alt text and the copy for the visual.
4. **Media**: HTML templates rendered with Playwright (statement, comparison, stat, checklist, screenshot),
   Remotion kinetic-typography videos, or real product clips with a title card and end card.
   AI image/video providers are used only when keys are set, with fallback to templates/Remotion.
5. **Critic**: hard rules (length, banned phrases, links, hashtags, X media limits, ffprobe checks), then a
   sonnet review that opens the image or video frames. Up to 3 regeneration rounds; otherwise the post is rejected.
6. **Publisher**: guards (pause, daily caps, min gap, duplicates), then X API v2 or a dry-run preview (`post.md`).

LLM calls run through `claude -p` on your Claude Code subscription (`src/llm.ts`), with your own settings,
hooks, plugins and MCP servers disabled for those calls.

## Quick start

```sh
pnpm install
cp .env.example .env                     # AUTOCM_MODE=dry_run by default
pnpm autocm products validate
pnpm autocm generate acme              # one post, format chosen by the strategist
pnpm autocm generate acme -f video     # force a format
pnpm autocm history acme
```

Generated artifacts land in `out/<product>/<date>/<postId>/` (brief, draft, media, frames, QA rounds, preview).

## Running on a schedule

```sh
pnpm autocm plan -d 2    # create posting slots inside each product's windows
pnpm autocm tick         # one pass: generate due slots (T-45 min), publish due posts
pnpm autocm run          # daemon: tick every 5 min, plan daily
```

`deploy/autocm.service` is a systemd user unit to keep `run` alive on this machine.

## Going live on X

1. Create an app at developer.x.com with Read and Write permissions, and generate OAuth 1.0a user tokens for the product's account.
2. Put them in `products/<slug>/.env` (see `products/.env.example`). Check with `pnpm autocm x whoami <slug>`.
3. Set `AUTOCM_MODE=live` in `.env`. Without both, everything stays dry-run.

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
