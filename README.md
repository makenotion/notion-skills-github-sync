# notion-skills-github-sync

Periodically sync skill pages from a Notion database into a GitHub repository
structured as a **Claude Code plugin marketplace**. One Notion page becomes one
plugin (containing one skill); the repo's `.claude-plugin/marketplace.json` is
kept in sync so the skills are installable in Claude Cowork / Claude Code.

Built for the **"Cowork Skills"** database (Notion dev workspace) → the
[`makenotion/epd-skills`](https://github.com/makenotion/epd-skills) repo.

## How it maps

Each published Notion page →

```
plugins/<slug>/
  .claude-plugin/plugin.json                 # name, version, description, author
  skills/<slug>/
    SKILL.md                                  # frontmatter (description) + page body
    .notion-sync.json                         # back-reference to the Notion page
```

and an entry in the root `.claude-plugin/marketplace.json`.

- **slug** comes from the `Skill name` title (lowercased, dashed, deduped).
- **description** comes from the `Description` property; if blank, it's derived
  from the first line of the body and a warning is printed.
- **body** is the Notion page content as Markdown.
- **`.notion-sync.json`** records the Notion `env` / database / data-source /
  page ids and page URL plus a content hash. Cowork clients use this to know
  where a skill came from and to write changes back later. It also marks the
  plugin as managed by this tool, so pruning never touches hand-authored plugins.

## Sync semantics

- Only rows with the **`Published`** checkbox checked are synced.
- **Notion is the source of truth** — manual edits to managed files are
  overwritten on the next sync.
- Skills removed/unpublished in Notion are **pruned** from the repo (files +
  marketplace entry). Hand-authored, non-managed plugins are left untouched.
- **Idempotent** — a sync with no real changes makes no commit (git-blob-sha
  diffing), so the cron never produces empty commits.
- Each sync is **one atomic commit** via the GitHub Git Data API.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- [`ntn`](https://github.com/makenotion/ntn) CLI, logged in to the dev
  workspace: `ntn --env dev login` (the tool shells out to it for Notion reads).
- GitHub auth: either `gh auth login` (the tool falls back to `gh auth token`)
  or a `GITHUB_TOKEN` with push access to the target repo.

## Setup

```bash
bun install
cp .env.example .env        # defaults already target Cowork Skills + epd-skills
```

Add the `Published` gate to the database and check existing rows (idempotent,
re-runnable):

```bash
bun run setup
```

## Usage

```bash
bun run dry-run             # show what would change, push nothing
bun run sync                # sync to the configured branch
bun run typecheck
bun test
```

Configuration (see `.env.example`):

| Var | Default | Notes |
|---|---|---|
| `NOTION_ENV` | `dev` | `ntn` environment (`local`/`dev`/`stg`/`prod`) |
| `NOTION_DATA_SOURCE_ID` | Cowork Skills DS | data source id (not the database id) |
| `NOTION_DATABASE_ID` | Cowork Skills DB | used by `setup` to add the property |
| `GITHUB_REPO` | `makenotion/epd-skills` | `owner/name` |
| `GITHUB_BRANCH` | `notion-sync` | use a test branch first; set to `main` when ready |
| `GITHUB_TOKEN` | (falls back to `gh auth token`) | needs push access |
| `PLUGINS_DIR` | `plugins` | where generated plugins live |

> Start with `GITHUB_BRANCH=notion-sync` to validate, then switch to `main`.

## Running on a cron (laptop)

`scripts/sync-cron.sh` cds into the project, fixes PATH for cron, and appends to
`sync.log`.

```bash
chmod +x scripts/sync-cron.sh
crontab -e
# hourly:
0 * * * * /Users/you/dev/notion-skills-github-sync/scripts/sync-cron.sh
```

On macOS you can use a launchd agent instead (more reliable across sleep):

```xml
<!-- ~/Library/LaunchAgents/com.notion.skills-sync.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.notion.skills-sync</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/dev/notion-skills-github-sync/scripts/sync-cron.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.notion.skills-sync.plist
```

## Deploying to Vercel (scaffolded)

`api/sync.ts` + `vercel.json` (hourly cron) are included. **Caveat:** the default
Notion adapter shells out to `ntn`, which isn't available in Vercel's runtime,
and the dev Notion workspace is likely unreachable externally. To run on Vercel:

1. Implement a direct-REST `NotionClient` (the interface in
   `src/notion/types.ts`) against a reachable API and inject it in `runSync`.
2. Set `GITHUB_TOKEN`, the Notion creds, and `CRON_SECRET` as Vercel env vars.

The GitHub write path already works anywhere (plain HTTPS + token).

## Architecture

```
src/
  cli.ts            commands: setup | sync [--dry-run]
  config.ts         env -> Config
  setup.ts          adds the Published property + checks rows
  sync.ts           orchestration: Notion -> plan -> GitHub commit
  plan.ts           pure: desired file set, prune set, marketplace merge (tested)
  convert.ts        pure: page -> SKILL.md / plugin.json / marker (tested)
  diff.ts           pure: git-blob-sha diffing / idempotency (tested)
  slugify.ts        pure: name -> unique slug (tested)
  github.ts         GitHub Git Data API client
  notion/
    types.ts        NotionClient interface (swap-in seam for REST/Vercel)
    ntn.ts          low-level `ntn` invocation
    ntn-adapter.ts  NotionClient backed by the `ntn` CLI
api/sync.ts         Vercel handler (see caveat above)
```

The pure modules hold all the conversion/diff logic and are unit-tested; the
network layers (`ntn`, GitHub) are thin and swappable.
