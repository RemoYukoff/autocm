# autocm

Autonomous X (Twitter) community manager. For each product in `products/<slug>/` it decides what to post
(text, image or video), generates it, QA-checks it and publishes it on a schedule, with no human approval.

## Rules
- Only modify files inside this repo. Other repos under `~/repos` are read-only references
  (copying assets *into* this repo is fine): `4foodies-content` (render/video patterns), `acme` (product).
- Contracts live in `src/core/types.ts`; frozen signatures in the stub modules (`src/media/index.ts`,
  `src/publish/index.ts`, `src/safety/guards.ts`, `src/scheduler/index.ts`, `src/pipeline.ts`).
  Change contracts only on `main`.
- Never publish to X live during development. `AUTOCM_MODE=dry_run` is the default; live needs explicit OK from the user.
- Never print or commit secrets. Per-product X creds go in `products/<slug>/.env` (gitignored).
- LLM calls go through `src/llm.ts` only (`claude -p` on the user's subscription). Use `AUTOCM_LLM=fake` in tests.

## Stack
TypeScript on Node 24 (ESM, run with `tsx`, no build), pnpm, `node:sqlite`, zod 4, Playwright (chromium),
Remotion 4, ffmpeg/ffprobe (system), twitter-api-v2, node-cron, pino, vitest.

## Commands
- `pnpm autocm <cmd>` — CLI (`src/cli.ts`): products list|validate, generate, publish, plan, tick, run, pause, resume, history, render-fixture, x whoami, status.
- `pnpm typecheck`, `pnpm test`.
- `pnpm tsx scripts/llm-smoke.ts [image]` — check `claude -p` structured output and image reading.

## Layout
- `products/<slug>/` product.yaml, knowledge/*.md, assets/ (logo, fonts, clips, screens)
- `templates/image/<id>/` HTML image templates; `remotion/` video compositions
- `src/core` config, db, types; `src/agents` LLM stages; `src/media` rendering; `src/publish` X; `src/safety` guards; `src/scheduler` slots/daemon
- `out/<product>/<date>/<postId>/` generated artifacts; `data/autocm.db` state (both gitignored)
