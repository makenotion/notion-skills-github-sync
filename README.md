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

The single source of truth for these differences is [`src/sync/clients.ts`](./src/sync/clients.ts).
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
writes your `.env`, pushes the sync script repo, stores the settings as repo
variables and the tokens as secrets, runs a test sync, verifies a real GitHub
Actions run end to end, and walks you through registering the marketplace in
Claude (against **prod** by default; add `--env dev` for internal dev):

```bash
bun install
bun run setup
```

To set things up manually instead:

```bash
bun install
cp .env.example .env    # fill in your settings and the two tokens
```

> **AI agents:** see [`AGENTS.md`](./AGENTS.md) for setting this up
> non-interactively, including how to create new databases.

## Usage

```bash
bun run dry-run             # show what would change, push nothing
bun run sync                # sync to the configured branch
bun run update              # pull tool updates from `upstream`
bun run typecheck
bun test
```

Sync reads skills through Notion's **Skills Public API**, which only reports
**typed** skills databases (`database_type: skills`). If you have an older
hand-built database, convert it **in-product** in Notion ("Turn into → Skills
DB") — it converts in place, so no config change is needed; just re-run `sync`
afterwards. An unconverted database syncs as zero skills.

## Configuration

Everything is an environment variable: `.env` locally (see
[`.env.example`](./.env.example)), repo **variables** + **secrets** in CI. Nothing
non-secret is committed, so every team's copy of this repo is identical and
`bun run update` never conflicts.

| Var | Required | Default | Notes |
|---|---|---|---|
| `NOTION_API_TOKEN` | Yes | — | Notion token with read access to your skills |
| `GITHUB_REPO` | Yes | — | target repo, `owner/name` |
| `GITHUB_TOKEN` | No | (falls back to `gh auth token`) | needs push access to the target |
| `GITHUB_BRANCH` | No | `main` | branch to sync into |
| `NOTION_ENV` | No | `prod` | `prod`/`dev`/`stg`/`local` — picks the API, app, and MCP hosts together |
| `NOTION_BASE_URL` | No | — | override the API host outright |
| `SKILLS_DATABASE_ID` / `SKILLS_DATA_SOURCE_ID` | No | — | not used to read skills; recorded in each skill's back-reference and the updater's write-back guidance |
| `CHANGE_REQUESTS_DATA_SOURCE_ID` | No | — | enables "propose a change" in the updater |
| `PLUGINS_DIR` | No | `plugins` | where generated plugins live |
| `PLUGIN_SLUG` | No | `skills` | fallback directory name for a plugin the API returns unnamed |
| `INJECT_UPDATER` / `UPDATER_SLUG` | No | `true` / `notion-skill-updater` | the injected write-back plugin |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | No | `notion-skills-sync` | commit author info |
| `AUTO_UPDATE` | No | `true` | merge tool updates from `upstream` before each scheduled sync |

> Point `GITHUB_BRANCH` at a throwaway branch first to validate the output, then
> switch it to your real branch.

**Coming from a `config.json`?** It still works as a deprecated fallback (env
wins key by key) and the sync warns, naming the variable that replaces each key
it's still reading. Convert it with:

```bash
bun run migrate-config    # writes .env, prints the `gh variable set` lines
```

## Staying up to date

Teams clone this repo rather than forking it, so `origin` is yours and
`upstream` is the tool:

```bash
bun run update            # fetch upstream, merge, then `git push origin HEAD`
```

It refuses to run on a dirty tree, and your `.env` is never part of the merge.
With `AUTO_UPDATE` on (the default) the workflow does this for you before each
scheduled sync and pushes the result to your repo, so you stay on current code
with no maintenance. The tradeoff is that a bad upstream change reaches you
automatically — set the `AUTO_UPDATE` variable to `false` to opt out.

## Running on GitHub Actions

`.github/workflows/sync.yml` runs the sync hourly (and via the manual **Run
workflow** button) on a stock Ubuntu runner. The sync is plain HTTPS on both
ends — the Notion Skills API and the GitHub Git Data API — so there's nothing to
install beyond Bun and no self-hosted runner needed.

The workflow runs **in this sync repo** and pushes plugins to the *target*
marketplace repo, so its secrets and variables go on **this repo**, not the
target:

| Secret | What |
|---|---|
| `NOTION_API_TOKEN` | Notion API token with read access to your skills |
| `GH_PUSH_TOKEN` | PAT / fine-grained token with `contents:write` on the target repo (the default `GITHUB_TOKEN` can't push to a *different* repo). With `AUTO_UPDATE` on it also needs `contents:write` + `workflows:write` on **this** repo, so an update that touches `sync.yml` can be pushed |

Everything non-secret is a repo **variable** — set them once and retarget without
a commit:

```bash
REPO=<owner>/<this-repo>
gh variable set SKILLS_GITHUB_REPO --repo "$REPO" --body "<owner>/<skills-repo>"
gh variable set NOTION_ENV --repo "$REPO" --body prod
```

GitHub rejects variable names starting with `GITHUB_`, which is why the two repo
settings are stored as `SKILLS_GITHUB_REPO` / `SKILLS_GITHUB_BRANCH` and mapped
back to `GITHUB_REPO` / `GITHUB_BRANCH` in the workflow.

## Deploying to Vercel (scaffolded)

`api/sync.ts` + `vercel.json` (hourly cron) are included but **unverified**.
Both ends of the sync are plain HTTPS now, so there's no runtime blocker left —
set `NOTION_API_TOKEN`, `GITHUB_TOKEN`, and `CRON_SECRET` as Vercel env vars and
confirm your Notion API host is reachable from the deployment.

## Architecture

The repo separates **talking to Notion's Skills API** (reusable by anyone) from
**publishing a plugin marketplace** (this tool's particular application):

```
src/
  notion/           ← the reusable part: reading skills out of Notion
    index.ts          NotionClient — one import gets you the whole capability
    env.ts            host resolution: prod | dev | stg | local
    auth.ts           Credential: a static token today, refreshable by design
    http.ts           shared transport: retries, typed errors, pagination
    skills.ts         /v1/ai/plugins, /v1/ai/skills/:id
    archive.ts        signed URL -> tar.gz -> files (+ untar.ts, zip expansion)
  sync/             ← the application: skills -> plugin marketplace
    engine.ts         orchestration; knows nothing about GitHub
    plan.ts           desired file set, prune set, per-client marketplaces
    layout.ts         plugin/skill paths, manifests, the sync marker
    clients.ts        supported clients + their manifest conventions
    updater.ts        the injected write-back plugin
    slugify.ts        name -> unique slug
  target/           ← where a sync writes
    target.ts         SyncTarget: readState() -> path→content id; apply(changes)
    github.ts         Git Data API implementation (one atomic commit per sync)
    memory.ts         in-memory implementation; the reference + what tests use
  setup/            guided setup (steps, logger, spinner shim, config migration)
  config.ts         environment -> Config (config.json as a deprecated fallback)
  update.ts         merge tool changes from `upstream`
  wire.ts           assemble a NotionClient + GitHubTarget from config
api/sync.ts         Vercel handler (see caveat above)
.github/workflows/sync.yml   hourly GitHub Actions sync
```

`SyncTarget` is the load-bearing boundary: the engine says "here is the desired
set of files and their content ids", and a GitHub target commits them while an
in-memory target records them. The `version_id` caching protocol works the same
for both, which is why the test suite can run a whole sync — API, pagination,
retries, archives, pruning, marketplaces — with no network on either side.

Using the Notion half on its own:

```ts
import { NotionClient } from "./src/notion/index.ts";

const notion = new NotionClient({ auth: process.env.NOTION_API_TOKEN!, env: "prod" });
for (const plugin of await notion.plugins.listAll()) {
  for (const skill of plugin.skills) {
    const { files } = await notion.skills.files({ skill_id: skill.id });
    // files["SKILL.md"], files["scripts/run.py"], …
  }
}
```

Its shape follows [`@notionhq/client`](https://github.com/makenotion/notion-sdk-js)
— `{ auth, baseUrl, notionVersion, fetch, retry }`, namespaced resource methods,
an error carrying Notion's own `code`, `collectPaginated` — so it could be lifted
into the SDK without redesign.
