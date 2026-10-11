# Products

Each folder here is one product autocm posts for. The pipeline reads `product.yaml` (validated against
`ProductConfig` in `src/core/types.ts`) and concatenates every `knowledge/*.md` file (sorted by name) into the
context the LLM agents use to plan and write posts.

## Add a product

Accounts are added only from the dashboard: **+ Add account** logs in to an X account, then autocm asks for the
product's website and writes this folder from it by itself (nobody edits it). **Delete** removes the folder, its X
session and its posts. The rest of this file documents what autocm writes, for reference.

1. The folder name is the slug (lowercase letters, digits and dashes):

   ```
   products/<slug>/
     product.yaml
     knowledge/            # 00-positioning.md, 10-features.md, ... (Markdown, sorted by file name)
     assets/
       logo.svg
       fonts/              # *.woff2 + fonts.css + the font license
       clips/              # short MP4 clips (H.264 yuv420p + AAC 48 kHz, +faststart, <= 8 MB each)
       screens/            # PNG screenshots for the "screenshot" image template
   ```

2. Write `product.yaml`. Paths are relative to `products/<slug>/`.

   | Field | What it is |
   | --- | --- |
   | `slug` | Must equal the folder name. |
   | `name`, `url` | Product name and site. The X handle comes from the connected account. |
   | `enabled` | `false` skips the product in `plan`/`tick`/`run`. |
   | `language`, `timezone` | Post language and the IANA zone the posting `windows` are in. |
   | `one_liner`, `audience` | One sentence each; the planner sees them on every post. |
   | `voice.rules` / `banned_phrases` / `example_posts` | Style rules, phrases the copywriter must avoid, and real lines to imitate. |
   | `pillars` | Content themes with `id`, `description` and relative `weight`. |
   | `format_mix` | Relative share of `text` / `image` / `video` posts. |
   | `cadence` | `posts_per_day_min` / `posts_per_day_max` (each day draws a count in between), `windows` (`"HH:MM-HH:MM"`), `daily_cap`, `min_gap_min`. |
   | `brand.colors` | `primary`, `accent`, `ink`, `bg`, optional `muted` (hex). |
   | `brand.fonts` | `sans`, optional `mono` (family names) and `files` (woff2 paths). |
   | `brand.logo` | Logo path (SVG preferred). |
   | `assets.clips` | `{id, path, description, start?, end?}`. The strategist picks clips by `description`, so say exactly what is on screen and what is said, plus aspect ratio and duration. |
   | `assets.screens` | `{id, path, description}` for the screenshot template. |
   | `links` | `cta_url`, optional `utm`, `max_link_ratio` (share of recent posts allowed to carry a link). |
   | `hashtags` | `max_per_post`. |

3. Write `knowledge/`. Keep it factual and sourced: the agents treat it as the only truth about the product.
   Include a "facts you must not claim" list (no invented customers, metrics or features).

4. The X account: no API keys, autocm posts through a logged-in browser. The login is the first step of adding
   the account; the session is kept in `data/sessions/<slug>/` (gitignored, never commit it). Each product posts from
   its own account. If the session breaks (logged out), the dashboard shows **Reconnect**.

5. Check it: `pnpm autocm products validate` (schema plus every referenced file exists), then
   `pnpm autocm products list`.
