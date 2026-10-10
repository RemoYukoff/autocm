# autocm

Autonomous X (Twitter) community manager. For each product in `products/<slug>/` it decides what to post
(text, image or video), generates it and publishes it on a schedule, with no human approval (a local dashboard allows vetoing).

## Rules
- Only modify files inside this repo. Other repos under `~/repos` are read-only references
  (copying assets *into* this repo is fine): `4foodies-content` (render/video patterns), `acme` (product).
- Contracts live in `src/core/types.ts`; frozen signatures in the stub modules (`src/media/index.ts`,
  `src/publish/index.ts`, `src/safety/guards.ts`, `src/scheduler/index.ts`, `src/pipeline.ts`).
  Change contracts only on `main`.
- There is no dry-run and no X API: posts go out through the product's logged-in browser profile
  (`data/sessions/<slug>/`, `src/x/`). Without a connected account a guard blocks publishing.
  Never run `tick` or `run` yourself against a connected product;
  tests mock the X client with `setXClientFactory` (the real client throws under vitest).
- `data/sessions/` holds X auth cookies: never log, print or commit anything from it.
- Long browser/X work must go through `track()` (`src/core/inflight.ts`) so `--watch` doesn't restart under it.
- Never print or commit secrets.
- LLM calls go through `src/llm.ts` only (Claude Agent SDK on the user's subscription). Use `AUTOCM_LLM=fake` in tests.
- Private single-user app: when behavior changes, delete the old path outright. No fallbacks to previous behavior,
  no optional fields defaulting to the old meaning, no compat for old product.yaml keys or DB rows (alter the DB instead).
- No LLM QA/critic stage: generated posts are approved unless X would refuse them (`src/agents/checks.ts`). The user vetoes from the dashboard.

## Stack
TypeScript on Node 24 (ESM, run with `tsx`, no build), pnpm, `node:sqlite`, zod 4, Claude Agent SDK, Hono, Playwright (chromium),
Remotion 4, ffmpeg/ffprobe (system), node-cron, pino, vitest.

## Commands
- `pnpm autocm <cmd>` — CLI (`src/cli.ts`): init-db, products list|validate, plan, tick, run [--dashboard] [--watch], dashboard, pause, resume, render-fixture, x connect|whoami, status.
- Each day the scheduler draws `cadence.posts_per_day_min..max` slots and the next tick writes them all; they publish at their time.
  The dashboard only shows what is about to publish (Up next) with Discard (veto) and Pause/Resume.
- The app runs always-on as systemd user service `autocm` (`deploy/autocm.service`, symlinked) with `run --dashboard --watch`
  from this checkout: edits to `src/`/`remotion/src/`/`.env` restart it once idle; `products/`, `templates/`, dashboard
  `public/` apply live. Don't start a second `run` by hand (port 4321 is taken). Logs: `journalctl --user -u autocm -f`.
- `pnpm typecheck`, `pnpm test`.
- `pnpm tsx scripts/llm-smoke.ts` — check Agent SDK structured output and that user settings do not leak in.

## Layout
- `products/<slug>/` product.yaml, knowledge/*.md, assets/ (logo, fonts, clips, screens)
- `templates/image/<id>/` HTML image templates; `remotion/` video compositions
- `src/dashboard` local veto UI (Hono, 127.0.0.1:4321)
- `src/core` config, db, types; `src/agents` LLM stages; `src/media` rendering; `src/publish` X; `src/safety` guards; `src/scheduler` slots/daemon
- `out/<product>/<date>/<postId>/` generated artifacts; `data/autocm.db` state (both gitignored)
