# notion-skills-github-sync

Periodically sync skill pages from a Notion database into a GitHub repository
structured as a **Claude Code and Codex plugin marketplace**. Published Notion
skills are grouped into plugins; the repo's Claude and Codex marketplace files
are kept in sync so the same skills are installable in Claude Cowork / Claude
Code and Codex.

## How it maps

Each published Notion page →

```
plugins/<slug>/
  .claude-plugin/plugin.json                 # name, version, description, author
  .codex-plugin/plugin.json                  # same plugin identity for Codex
  skills/<slug>/
    SKILL.md                                  # frontmatter (description) + page body
    .notion-sync.json                         # back-reference to the Notion page
```

and entries in both marketplace files:

```
.claude-plugin/marketplace.json              # Claude Code marketplace
.agents/plugins/marketplace.json             # Codex marketplace
```

> **Maintainers & coding agents:** see [`CLAUDE.md`](./CLAUDE.md) for this
> deployment's specifics, the GitHub Actions runbook, secret rotation, the
> validation loop, and gotchas.

- **slug** comes from the `Skill name` title (lowercased, dashed, deduped).
- **plugin slug** comes from the optional `Plugins` property; if blank, the
  skill goes into the default `skills` plugin. Plugin manifests use this plugin
  slug as their `name`, because Claude and Codex both namespace skills by plugin
  identity.
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
  marketplace entries). Hand-authored, non-managed plugins are left untouched.
- **Idempotent** — a sync with no real changes makes no commit (git-blob-sha
  diffing), so scheduled runs never produce empty commits.
- Each sync is **one atomic commit** via the GitHub Git Data API.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2 — **required** (Node.js is not supported; the CLI
  and all scripts run under Bun and import `.ts` directly). Install it with:

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

  then restart your shell (or `source` your profile) so `bun` is on your `PATH`,
  and confirm with `bun --version`.
- The `ntn` CLI, logged in to the Notion workspace that holds your database
  (the tool shells out to it for Notion reads).
- GitHub auth: either `gh auth login` (the tool falls back to `gh auth token`)
  or a `GITHUB_TOKEN` with push access to the target repo.

### Admin settings & approvals the guided setup can hit

The guided setup surfaces clear errors for these, but a **workspace/org admin**
may need to act, so it helps to line them up first:

- **Notion — "Limit who can create personal access tokens"** (Admin Center →
  Connections → Manage). If restricted, `ntn login` fails silently during
  setup. An admin should temporarily set it to *all workspace members*. This
  PAT is only used by the `ntn` CLI during setup — the ongoing sync uses the
  Notion connection token, so PAT creation can be re-restricted right after.
- **Notion — "Limit who can create internal connections"** (same location).
  If restricted, creating the sync's internal connection + access token is
  blocked. An admin should set it to *all workspace members*.
- **GitHub — fine-grained PAT expiration.** On the token form, keep the
  pre-filled expiration (or pick a preset like 90 days). A bad *custom* date
  triggers an easy-to-miss inline validation error — clicking **Generate token**
  then appears to do nothing and no token is shown.
- **GitHub — org PAT approval.** If your org requires approval for fine-grained
  tokens, an org admin must approve the newly created token at *Organization
  Settings → Personal access tokens → Pending requests* before it works. The
  token is scoped to only the skills repo (Contents: read/write).
- **Claude/Codex — GitHub app access to the skills repo.** When registering the
  marketplace, if the skills repo doesn't appear in the client, the relevant
  GitHub app may be set to *Only select repositories* — add the skills repo to
  that app installation. The repo must also be visible to whoever does the
  client-side setup (add them as a collaborator if org repo visibility is
  restricted).

## Setup

The guided setup is the easiest path. It asks everything up front, then runs
mostly unattended: it creates the Notion Skills DB and both GitHub repos (the
skills repo the plugins are published to, and the sync script repo the hourly
workflow runs in), pauses once while you create two dedicated access tokens —
a fine-grained GitHub PAT scoped to just the skills repo (via a pre-filled
form) and a Notion integration token connected to just the Skills DB — then
writes `config.json`, pushes the sync script repo with its secrets, runs a
test sync, verifies a real GitHub Actions run end to end, and walks you
through registering the marketplace in Claude (against **prod** by default;
Codex can install from the same generated repo; add `--env dev` for internal
dev):

```bash
bun install
bun run setup
```

To set things up manually instead:

```bash
bun install
cp config.json.example config.json  # fill in all settings
```

All non-secret configuration lives in `config.json`. Secrets (like `GITHUB_TOKEN`)
go in `.env` or as environment variables.

> **AI agents:** If `config.json` is missing, see [`AGENTS.md`](./AGENTS.md) for
> instructions on setting it up, including how to create new databases.

## Usage

```bash
bun run dry-run             # show what would change, push nothing
bun run sync                # sync to the configured branch
bun run typecheck
bun test
```

**config.json** (see `config.json.example`):

| Field | Required | Default | Notes |
|---|---|---|---|
| `skillsDataSourceId` | Yes | — | skills data source id |
| `githubRepo` | Yes | — | target repo, `owner/name` |
| `notionEnv` | No | `prod` | `ntn` environment (`dev`/`stg`/`prod`) |
| `skillsDatabaseId` | No | — | database ID wrapping the data source; recorded in plugin back-references |
| `changeRequestsDataSourceId` | No | — | enables "propose a change" in the updater |
| `githubBranch` | No | `main` | branch to sync into |
| `pluginsDir` | No | `plugins` | where generated plugins live |
| `authorName` / `authorEmail` | No | `notion-skills-sync` | commit author info |

**Environment variables** (secrets only — see `.env.example`):

| Var | Default | Notes |
|---|---|---|
| `GITHUB_TOKEN` | (falls back to `gh auth token`) | needs push access |

> Point `githubBranch` at a throwaway branch first to validate the output, then
> switch it to your real branch.

## Running on GitHub Actions

`.github/workflows/sync.yml` runs the sync hourly (and via the manual **Run
workflow** button). It installs `ntn` on a stock Ubuntu runner
(`curl -fsSL https://ntn.dev | bash`), so no self-hosted runner is needed.

The workflow runs **in this sync repo** (push this repo, with `config.json`
committed, to GitHub) and pushes plugins to the *target* marketplace repo. So
the two secrets go on **this repo**, not the target:

| Secret | What |
|---|---|
| `NOTION_API_TOKEN` | Notion API token (ntn reads it from the env, overriding keychain auth) |
| `GH_PUSH_TOKEN` | PAT / fine-grained token with `contents:write` on the target repo (the default `GITHUB_TOKEN` can't push to a *different* repo) |

The non-secret config (env, data-source/database ids, target repo/branch) comes
from the committed `config.json` — edit and push to retarget. If you host the
workflow *inside* the target repo itself, you can drop the push-token secret and
use the built-in token with `permissions: contents: write`.

## Deploying to Vercel (scaffolded)

`api/sync.ts` + `vercel.json` (hourly cron) are included. **Caveat:** the default
Notion adapter shells out to `ntn`, which isn't available in Vercel's runtime,
and your Notion API host may not be reachable from the serverless runtime. To run
on Vercel:

1. Implement a direct-REST `NotionClient` (the interface in
   `src/notion/types.ts`) against a reachable API and inject it in `runSync`.
2. Set `GITHUB_TOKEN`, the Notion creds, and `CRON_SECRET` as Vercel env vars.

The GitHub write path already works anywhere (plain HTTPS + token).

## Architecture

```
src/
  cli.ts            commands: setup (guided, also --ci) | sync [--dry-run]
  config.ts         config.json -> Config
  wizard/           the guided setup flow (steps, logger, spinner shim)
  sync.ts           orchestration: Notion -> plan -> GitHub commit
  plan.ts           pure: desired file set, prune set, marketplace merges (tested)
  convert.ts        pure: page -> SKILL.md / plugin manifests / marker (tested)
  diff.ts           pure: git-blob-sha diffing / idempotency (tested)
  slugify.ts        pure: name -> unique slug (tested)
  github.ts         GitHub Git Data API client
  notion/
    types.ts        NotionClient interface (swap-in seam for REST/Vercel)
    ntn.ts          low-level `ntn` invocation
    ntn-adapter.ts  NotionClient backed by the `ntn` CLI
api/sync.ts         Vercel handler (see caveat above)
.github/workflows/sync.yml   hourly GitHub Actions sync (installs ntn)
```

The pure modules hold all the conversion/diff logic and are unit-tested; the
network layers (`ntn`, GitHub) are thin and swappable.
