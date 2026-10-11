# autocm

Autonomous X (Twitter) community manager. For each product in `products/<slug>/` it decides what to post
(text, image or video), generates it and publishes it on a schedule, with no human approval (a local dashboard allows vetoing).
Post making: marketer (`src/agents/marketer.ts` + `playbook.ts`) -> dedupe -> copywriter -> designer agent for images
(`src/agents/designer.ts`, HTML/CSS it renders and checks itself via `src/media/design.ts`) or the editor agent for
video (`src/agents/editor.ts`: a timeline of HTML/CSS scenes, footage and audio, `src/media/edit.ts`, rendered by the
one Remotion composition `remotion/src/Edit.tsx`). There are no image or video templates.
Generated pictures, footage and music come from ElevenLabs via its MCP (`src/media/elevenlabs.ts`, OAuth login of Claude Code's
user-scope `elevenlabs` server). Every generation spends the user's ElevenLabs credits: never loop or retry one.
The marketer learns from engagement read back from X (`src/publish/metrics.ts`) and from posts discarded in the dashboard.

## Rules
- Only modify files inside this repo. Other repos under `~/repos` are read-only references
  (copying code *into* this repo is fine): `4foodies-content` (render/video patterns).
- The repo is public and holds code only. `products/`, `fixtures/`, `out/`, `data/` and `.env` stay local (gitignored):
  never commit product content, generated posts or anything about a specific product.
- Do not write unit or integration tests. Check changes with `pnpm typecheck` and by running the real thing
  (`render-fixture`, the dashboard in headless Chromium).
- Contracts live in `src/core/types.ts`; frozen signatures in the stub modules (`src/media/index.ts`,
  `src/publish/index.ts`, `src/safety/guards.ts`, `src/scheduler/index.ts`, `src/pipeline.ts`).
  Change contracts only on `main`.
- There is no dry-run and no X API: posts go out through the product's logged-in browser profile
  (`data/sessions/<slug>/`, `src/x/`). Without a connected account a guard blocks publishing.
  Never run `tick` or `run` yourself against a connected product.
- `data/sessions/` holds X auth cookies: never log, print or commit anything from it.
- Long browser/X work must go through `track()` (`src/core/inflight.ts`) so `--watch` doesn't restart under it.
- Never print or commit secrets.
- LLM calls go through `src/llm.ts` only (Claude Agent SDK on the user's subscription).
- Private single-user app: when behavior changes, delete the old path outright. No fallbacks to previous behavior,
  no optional fields defaulting to the old meaning, no compat for old product.yaml keys or DB rows (alter the DB instead).
- No LLM QA/critic stage: generated posts are approved unless X would refuse them (`src/agents/checks.ts`). The user vetoes from the dashboard.

## Stack
TypeScript on Node 24 (ESM, run with `tsx`, no build), pnpm, `node:sqlite`, zod 4, Claude Agent SDK, Hono, Playwright (chromium),
Remotion 4, ffmpeg/ffprobe (system), node-cron, pino.

## Commands
- `pnpm autocm <cmd>` — CLI (`src/cli.ts`): init-db, products list|validate, plan, tick, run [--dashboard] [--watch], dashboard, pause|resume <product>, render-fixture, x connect|whoami, status.
- Each day the scheduler draws `cadence.posts_per_day_min..max` slots and the next tick writes them all; they publish at their time.
  The dashboard shows one account at a time (remembered, else the first), one day at a time (default today; a day strip,
  newest left, covers planned days and the past week, a calendar the older days with posts): every post of that day,
  published ones linked to X. Unpublished posts have Discard (deletes the post, its slot and files outright),
  an editable time, "+ Generate post" (adds a slot at a free time and kicks a tick so it is written now)
  and that account's Pause/Resume. Pause is per account (flag `paused:<slug>`) and only stops publishing:
  posts are still written. There is no global pause.
- The app runs always-on as systemd user service `autocm` (`deploy/autocm.service`, symlinked) with `run --dashboard --watch`
  from this checkout: edits to `src/`/`remotion/src/`/`.env` restart it once idle; `products/`, dashboard
  `public/` apply live. Don't start a second `run` by hand (port 4321 is taken). Logs: `journalctl --user -u autocm -f`.
- `pnpm typecheck`.
- `pnpm tsx scripts/llm-smoke.ts` — check Agent SDK structured output and that user settings do not leak in.
- `pnpm tsx scripts/tool-smoke.ts <png>` — check image input and in-process tool calls (what the designer relies on).

## Layout
- `products/<slug>/` product.yaml, knowledge/*.md, assets/ (logo, fonts, clips, screens); local only, format in `docs/products.md`
- `fixtures/media/*.json` sample `{brief, draft}` pairs for `render-fixture`; local only
- `remotion/` video compositions (images have no templates: the designer agent writes each one)
- `src/dashboard` local veto UI (Hono, 127.0.0.1:4321)
- `src/core` config, db, types; `src/agents` LLM stages; `src/media` rendering; `src/publish` X; `src/safety` guards; `src/scheduler` slots/daemon
- `out/<product>/<date>/<postId>/` generated artifacts; `data/autocm.db` state (both gitignored)
