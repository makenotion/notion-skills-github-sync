# notion-skills-github-sync

Periodically sync your Notion workspace's skills into a GitHub repository
structured as a **multi-client plugin marketplace**. Skills are read through
Notion's Skills Public API, and each sync emits the plugin manifests every
supported coding client expects — so the same skills are installable in **Claude
Code**, **Cursor**, and **Codex** from a single repo.

## Supported clients

Every client reads the *same* per-plugin manifest content (name, version,
description, author) — they only differ on **where** that manifest lives and on
the shape of the repo-root marketplace file that lists the plugins:

| Client      | Per-plugin manifest                | Marketplace manifest              |
| ----------- | ---------------------------------- | --------------------------------- |
| Claude Code | `<plugin>/.claude-plugin/plugin.json` | `.claude-plugin/marketplace.json`   |
| Cursor      | `<plugin>/.cursor-plugin/plugin.json` | `.cursor-plugin/marketplace.json`   |
| Codex       | `<plugin>/.codex-plugin/plugin.json`  | `.agents/plugins/marketplace.json`  |

The single source of truth for these differences is [`src/clients.ts`](./src/clients.ts).
Add a client there (its manifest dir, marketplace path, and entry shape) and the
sync emits its manifests everywhere automatically.

## How it maps

Your workspace's skills →

```
plugins/<plugin>/                            # one dir per skills plugin in Notion
  .claude-plugin/plugin.json                 # Claude manifest  ┐ identical
  .cursor-plugin/plugin.json                 # Cursor manifest  │ content,
  .codex-plugin/plugin.json                  # Codex manifest   ┘ shared metadata
  skills/<slug>/                             # one dir per Notion skill
    SKILL.md                                  # rendered by Notion (name + description frontmatter)
    .notion-sync.json                         # back-reference to the Notion skill
    scripts/… references/… etc.               # the page's Files attachments (see below)
```

and an entry in each client's marketplace manifest:

```
.claude-plugin/marketplace.json              # Claude Code
.cursor-plugin/marketplace.json              # Cursor
.agents/plugins/marketplace.json             # Codex
```

The Claude and Cursor marketplace entries share the simple
`{ name, source, description }` shape; Codex uses its structured
`{ name, source: { source, path }, policy, category }` form.

### Skills with files & folders (optional)

A skill can ship more than a `SKILL.md` — helper scripts, reference docs, whole
folders. Attach them to the page's **`Files`** property (a normal Notion files
property); Notion delivers them alongside the rendered `SKILL.md`. The contract:

- **No attachments is the normal case** for a skill that's just instructions —
  leave `Files` empty.
- Loose attachments land flat next to `SKILL.md`. To ship **nested folders**
  (`scripts/`, `assets/`), attach a **single `.zip`** with the contents at the
  archive root (not a wrapping folder); it's expanded in place on sync.
  Anything else (several zips, macOS cruft) is left as delivered or ignored
  rather than treated as an error.
- Any `SKILL.md` inside the zip is ignored (the Notion page wins).
- The skill dir is fully managed: removing an attachment prunes it on the next
  sync.

Agents write files back with the `ntn` CLI (upload the zip, then attach it to
the `Files` property) — that's a write path, separate from the read-only Skills
API the sync uses. The injected `notion-skill-updater` skill spells out the
whole flow.

> **Maintainers & coding agents:** see [`CLAUDE.md`](./CLAUDE.md) for this
> deployment's specifics, the GitHub Actions runbook, secret rotation, the
> validation loop, and gotchas.

Skills come from Notion's **Skills Public API**, which does most of this work
server-side:

- **`SKILL.md`** is rendered by Notion, frontmatter (`name`, `description`) and
  all, and shipped inside a `.tar.gz` per skill. This tool writes it verbatim.
- **slug** is the page title, kebab-cased by the API; collisions within one sync
  get a `-2`, `-3` suffix.
- **description** comes from the skill's `Description`; when it's blank Notion
  falls back to the page's own summary, so there's nothing to configure.
- **files** (optional) are the page's `Files` attachments, delivered alongside
  `SKILL.md`. A lone `.zip` is expanded in place so nested folders survive.
- **plugin** — the API groups skills into plugins (your team's plugins, plus
  Notion's own built-in workspace skills). Each becomes its own directory, named
  after the plugin, and gets its own marketplace entry. Rename a plugin in Notion
  and the directory follows on the next sync.
- **`.notion-sync.json`** records the Notion `env`, the skill directory id and
  URL, and the API's opaque `version_id`. Clients use this to know where a skill
  came from and to write changes back later. It also marks the plugin as managed
  by this tool, so pruning never touches hand-authored plugins — and the sync
  compares it against the API's `version_id` to skip re-downloading skills that
  haven't changed.

## Sync semantics

- **Every skill the Notion connection can read is synced.** There's no publish
  checkbox — grant the connection access to exactly the skills you want
  published.
- **Notion is the source of truth** — manual edits to managed files are
  overwritten on the next sync.
- Skills deleted in Notion (or no longer readable by the connection) are
  **pruned** from the repo (files + every client's marketplace entry).
  Hand-authored, non-managed plugins are left untouched.
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
- `NOTION_API_TOKEN` — a Notion connection token with read access to your
  skills. The sync calls the Notion Skills API over plain HTTPS; there is no CLI
  in that path.
- The `ntn` CLI, logged in to the Notion workspace that holds your database.
  **Only needed for `bun run setup`**, not for syncing.
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
- **Claude — GitHub app access to the skills repo.** When registering the
  marketplace, if the skills repo doesn't appear ("Repo missing? Install the
  Claude GitHub app…"), the org's Claude GitHub app is set to *Only select
  repositories* — add the skills repo to that app installation. The repo must
  also be visible to whoever does the Claude-side setup (add them as a
  collaborator if org repo visibility is restricted).

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
add `--env dev` for internal dev):

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

Sync reads skills through Notion's **Skills Public API**, which only reports
**typed** skills databases (`database_type: skills`). If you have an older
hand-built database, convert it **in-product** in Notion ("Turn into → Skills
DB") — it converts in place, so no config change is needed; just re-run `sync`
afterwards. An unconverted database syncs as zero skills.

**config.json** (see `config.json.example`):

| Field | Required | Default | Notes |
|---|---|---|---|
| `githubRepo` | Yes | — | target repo, `owner/name` |
| `notionEnv` | No | `prod` | Notion environment (`dev`/`stg`/`prod`) — picks the API host |
| `skillsDataSourceId` | No | — | not used to read skills; recorded in plugin back-references and the updater's write-back guidance |
| `skillsDatabaseId` | No | — | ditto |
| `changeRequestsDataSourceId` | No | — | enables "propose a change" in the updater |
| `githubBranch` | No | `main` | branch to sync into |
| `pluginsDir` | No | `plugins` | where generated plugins live |
| `pluginSlug` | No | `skills` | fallback directory name for a plugin the API returns unnamed |
| `authorName` / `authorEmail` | No | `notion-skills-sync` | commit author info |

**Environment variables** (secrets only — see `.env.example`):

| Var | Default | Notes |
|---|---|---|
| `NOTION_API_TOKEN` | — | **required**; needs read access to your skills |
| `GITHUB_TOKEN` | (falls back to `gh auth token`) | needs push access |

> Point `githubBranch` at a throwaway branch first to validate the output, then
> switch it to your real branch.

## Running on GitHub Actions

`.github/workflows/sync.yml` runs the sync hourly (and via the manual **Run
workflow** button) on a stock Ubuntu runner. The sync is plain HTTPS on both
ends — the Notion Skills API and the GitHub Git Data API — so there's nothing to
install beyond Bun and no self-hosted runner needed.

The workflow runs **in this sync repo** (push this repo, with `config.json`
committed, to GitHub) and pushes plugins to the *target* marketplace repo. So
the two secrets go on **this repo**, not the target:

| Secret | What |
|---|---|
| `NOTION_API_TOKEN` | Notion API token with read access to your skills |
| `GH_PUSH_TOKEN` | PAT / fine-grained token with `contents:write` on the target repo (the default `GITHUB_TOKEN` can't push to a *different* repo) |

The non-secret config (env, data-source/database ids, target repo/branch) comes
from the committed `config.json` — edit and push to retarget. If you host the
workflow *inside* the target repo itself, you can drop the push-token secret and
use the built-in token with `permissions: contents: write`.

## Deploying to Vercel (scaffolded)

`api/sync.ts` + `vercel.json` (hourly cron) are included but **unverified**.
Both ends of the sync are plain HTTPS now, so there's no runtime blocker left —
set `NOTION_API_TOKEN`, `GITHUB_TOKEN`, and `CRON_SECRET` as Vercel env vars and
confirm your Notion API host is reachable from the deployment.

## Architecture

```
src/
  cli.ts            commands: setup (guided, also --ci) | sync [--dry-run]
  config.ts         config.json -> Config
  wizard/           the guided setup flow (steps, logger, spinner shim)
  sync.ts           orchestration: Skills API -> plan -> GitHub commit
  clients.ts        pure: supported clients + their manifest conventions (tested)
  plan.ts           pure: desired file set, prune set, per-client marketplaces (tested)
  convert.ts        pure: skill directory -> plugin manifests / marker (tested)
  files.ts          skill archive: download / extract / expand a lone zip (tested)
  untar.ts          pure: minimal tar reader, ustar + PAX + GNU long names (tested)
  diff.ts           pure: git-blob-sha diffing / idempotency (tested)
  slugify.ts        pure: name -> unique slug (tested)
  github.ts         GitHub Git Data API client
  notion/
    skills-api.ts   Notion Skills Public API client (tested)
    ntn.ts          low-level `ntn` invocation — used by `setup` only
api/sync.ts         Vercel handler (see caveat above)
.github/workflows/sync.yml   hourly GitHub Actions sync
```

The pure modules hold all the conversion/diff logic and are unit-tested; the
network layers (Notion, GitHub) are thin and swappable.
