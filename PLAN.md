# Notion → GitHub Skills Sync — Plan

## End goal

A standalone TypeScript (Bun) utility that periodically syncs skill pages from a
Notion database into a GitHub repository structured as a **Claude Code plugin
marketplace**. Runs on a laptop cron now; structured so it can later deploy to a
host like Vercel.

- **Source of truth:** Notion DB **"Cowork Skills"** (dev workspace)
  - database id `37db35e6e67f807b8dbad604dbe211ec`
  - data source id `37db35e6-e67f-8009-b4f2-000b10918252`
  - per page: `Skill name` (title) → slug + name; `Description` (rich_text) →
    SKILL.md `description`; page body → SKILL.md content; **`Published`**
    (checkbox, added by `setup`) → ready gate.
- **Target:** `makenotion/epd-skills` (validation branch: `notion-sync`).
  - One Notion page → one plugin `plugins/<slug>/` containing
    `.claude-plugin/plugin.json` + `skills/<slug>/SKILL.md`, registered in the
    root `marketplace.json`.

## Key decisions (from interview)

1. **Fresh build, reuse logic.** New project; borrow ideas (not a dependency)
   from `brianlovin/notion-skills` (`~/dev/notion-skills`).
2. **Notion access via `ntn` CLI** (`ntn --env dev`). Already authenticated to
   the dev workspace and returns page bodies as Markdown directly. Wrapped behind
   a `NotionClient` interface so a direct-REST adapter can be added later for
   Vercel/prod (dev API is likely unreachable from external hosts — documented).
3. **GitHub writes via the GitHub Git Data API** (token from `GITHUB_TOKEN` or
   `gh auth token`). One atomic commit per sync; works on laptop and serverless.
4. **Runtime: Bun + TypeScript, no Vite.** Node-compatible ESM output.
5. **Sync semantics:** only `Published` rows; prune skills removed from Notion;
   Notion always wins (overwrite repo edits); idempotent (no empty commits).
6. **Safety — managed marker.** Each generated plugin gets a
   `.notion-sync.json` marker (pageId, skillsDataSourceId, contentHash). Only
   marker-bearing plugins are ever updated/pruned, so hand-authored plugins
   (e.g. `hello-world`) are never clobbered.

## Mapping detail

`plugins/<slug>/.claude-plugin/plugin.json`
```json
{ "name": "<slug>", "version": "1.0.0", "description": "<desc>", "author": { "name": "<created-by>" } }
```
`plugins/<slug>/skills/<slug>/SKILL.md`
```
---
description: <desc>
---
<body>
```
`plugins/<slug>/.notion-sync.json` → `{ pageId, skillsDataSourceId, contentHash }`

Root `marketplace.json`: preserve non-managed entries; add/update/remove managed
entries `{ name, source: "./plugins/<slug>", description }`.

Slugify: lowercase, trim, non-alphanumeric → `-`, collapse/trim dashes; collision
suffixing. Empty `Description` falls back to the first body paragraph (truncated)
with a warning.

## Validation criteria

1. `bun run typecheck` clean; `bun test` green.
2. Unit tests cover: slugify (incl. trailing-space + collisions), SKILL.md +
   plugin.json generation, frontmatter stripping of `ntn pages get` output,
   marketplace merge/preserve/prune, file-set diff/idempotency (git blob sha),
   description fallback.
3. **Dry run** against the real DB prints exactly the 3 expected plugins
   (`message-review`, `customer-feedback-collection`,
   `product-thinking-first-pass`) + marketplace entries, with bodies.
4. **E2E:** `setup` adds `Published` + checks the 3 rows; `sync` pushes to the
   `notion-sync` branch; verify via `gh` that each `plugins/<slug>/` (plugin.json,
   SKILL.md, marker) and `marketplace.json` are correct and `hello-world` is
   preserved.
5. **Idempotency:** immediate re-run creates **no** new commit.
6. **Prune:** uncheck one row → re-sync removes that plugin + its marketplace
   entry; `hello-world` still present.

## Validation loop

build → `typecheck` → `bun test` → `sync --dry-run` (real DB) → `setup` → `sync`
to `notion-sync` → verify with `gh api`/`gh` → re-run for idempotency → prune
check. Fix and repeat until all criteria pass.

## Tradeoffs

- **Robustness > simplicity** on the GitHub write path: Git Data API (atomic
  multi-file commit, true prune, blob-sha idempotency) over the simpler
  per-file Contents API.
- **Accept the `ntn` dependency** now (fastest path to real dev data) with a
  clean adapter seam rather than fighting dev-API auth/networking for Vercel
  today.
- **Managed marker** adds a tiny bit of state per plugin to make pruning safe;
  worth it to never clobber hand-authored skills.
- **Description fallback** keeps the pipeline working with today's empty
  descriptions while loudly warning, instead of hard-failing.

## Out of scope (for now)

- Working Vercel deployment against dev Notion (needs REST adapter + reachable
  API). `api/` handler + `vercel.json` cron are scaffolded and documented.
- Richer mappings (multi-skill plugins, scripts/references/assets dirs).
