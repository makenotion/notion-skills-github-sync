# CLAUDE.md — agent & maintainer notes

Operational + deployment context for this repo. The [README](./README.md) is the
generic, shareable description of the tool; **this file is the specifics of how
it's actually deployed and the hard-won gotchas.** Read both.

> One-line mental model: read skill pages from a Notion database → render each to
> Claude Code, Cursor, and Codex plugin manifests → commit the whole set into a
> GitHub repo that's a multi-client plugin marketplace, on a schedule.

## Configuration overview

Configuration lives in two places:
- **`config.json`** (committed to the repo) — all non-secret settings
- **GitHub repo secrets** — authentication tokens (`NOTION_API_TOKEN`, `GH_PUSH_TOKEN`)

To set up: copy `config.json.example` to `config.json`, fill in your settings,
and commit it. Secrets go in GitHub repo secrets (or `.env` for local dev).
See [`AGENTS.md`](./AGENTS.md) for AI agent setup.

## Interactive setup

`bun run setup` is the deterministic, guided setup (formerly `wizard`; the old
one-shot `setup` command that only added the Published property is gone — its
schema work happens during DB creation now). It's structured to front-load all
decisions and then run unattended, in six phases (one file per phase in
`src/wizard/steps/`):

1. **Preflight** — tool checks + `ntn`/`gh` CLI auth (wizard tooling only,
   never sync credentials). If `ntn login` fails, it re-verifies auth and, on
   failure, names the blocking Notion admin setting ("Limit who can create
   personal access tokens", Admin Center → Connections → Manage) rather than
   dying silently.
2. **Decisions** — every question, each with context, then ONE plan-summary
   confirm. The DB name isn't asked (auto: "Skills", renameable in Notion;
   `--db-name` overrides). Vocabulary used throughout: **Notion Skills DB**
   (source of truth), **skills repo** (plugins are published here; Claude reads
   it as a marketplace), **sync script repo** (this code + config.json; the
   hourly workflow runs here — default is to push to a NEW origin the user
   owns, keeping the old origin as `upstream`). The skills repo is **always
   private** (no public option — a public skills repo makes no sense and
   private is required for Claude org registration). Repo-owner pickers
   **default to the user's GitHub org** (orgs listed first, personal account
   last and never the default) so org rollouts don't land under a personal
   account; both repos use the same owner-dropdown-then-name prompts, and the
   sync script repo's owner defaults to whatever was picked for the skills
   repo. Choosing an **existing** skills repo requires an explicit
   overwrite confirmation (the sync rewrites/prunes the target every run);
   declining loops back to the choice instead of killing setup.
3. **Resources** — creates the Notion Skills DB (+schema/samples via the
   shared `src/wizard/skills-db.ts`, also used by `--ci`), the skills repo, and
   the sync script repo. No prompts; failures abort with a handoff. One sample
   (Meeting Notes) ships bundled files — a Python script under `scripts/` and a
   PNG banner under `assets/` — zipped (`zipSkillFiles`) and uploaded via
   `ntn files create`, then attached to the page's `Files` property at
   creation, so a fresh setup exercises the zip flow out of the box.
4. **Credentials** — the single manual pause, deliberately AFTER resources
   exist. Two **dedicated minimal-blast-radius tokens**, never the cached
   `gh`/`ntn` CLI credentials (those are account-wide; the gh one carries
   `repo` + `admin:public_key`): a fine-grained GitHub PAT via a pre-filled
   URL (`buildPatUrl` — GitHub's form supports name/owner/expiry/permissions
   params but NOT repo pre-selection, which is why the skills repo must exist
   first), and a Notion access token (Connections page → New connection →
   Access token method). The "connect it to the DB" step is verified by
   **polling the DB with the pasted token** — no honor-system confirm. This
   step also prints the setup-call gotchas inline (see `src/wizard/guidance.ts`):
   the org PAT-approval path (Organization Settings → Personal access tokens →
   Pending requests) and the Notion "Limit who can create internal connections"
   admin setting.
5. **Deploy** — unattended tail: config.json → push sync script repo → secrets
   → local test sync (run with the SAME dedicated tokens the workflow will
   use) → dispatch + watch a real Actions run.
6. **Wrap-up** — register-the-marketplace steps (Organization settings →
   Plugins) with a done-confirm to pace the output, then a short summary and
   an offer to open the Skills DB. Also prints the Claude GitHub-app gotcha:
   a private skills repo won't appear in Claude's picker unless the org's
   Claude GitHub app (if set to "Only select repositories") is granted access
   to it, and the repo is visible to whoever does the Claude-side setup.

- **Runs against prod by default.** Dev is opt-in with `bun run setup --env dev`
  (internal Notion use). The chosen env is threaded through *every* Notion
  call and written to `config.json` as `notionEnv` — so the database is created
  in the same env the sync later reads from. (Getting these out of sync is what
  produced a `404 object_not_found` at the test-sync step: DB created in dev,
  sync configured for prod.)
- **Test runs:** `bun run setup --test-run` (interactive only) runs the whole
  real setup, then adds a final cleanup step (`src/wizard/steps/cleanup.ts`)
  that offers to delete the GitHub repos the run created (`gh repo delete`,
  with a `gh auth refresh -h github.com -s delete_repo` hint if the scope is
  missing) and restores the rewired git remotes (`upstream` → `origin`).
  Pre-existing repos the user chose to reuse are never deleted; the Notion
  Skills DB is left for the user to trash in Notion.
- **Non-interactive:** `bun run setup --ci` (for agents/CI) — see
  `src/wizard/non-interactive.ts`. Also honors `--repo`, `--db-name`,
  `--db-parent-page`. CI mode doesn't push the sync script repo or dispatch
  Actions, and takes credentials from the environment instead of the
  dedicated-token checkpoint.
- **Diagnostic log:** every run writes a JSONL log to
  `.notion-sync-setup/setup-<ts>.log.jsonl` (gitignored). It's crash-proof (one
  JSON object per line, flushed as it goes, with a `crash` record + stack on
  failure) and **redacts tokens**. Share/read this file to debug a stuck setup.
- The wizard's spinners are a local shim (`src/wizard/spinner.ts`), not
  `@clack`'s — clack's spinner grabs stdin via `block()`, which could
  `process.exit(0)` on a stray escape/empty keypress. The shim never touches
  stdin, so that whole failure mode is gone. Don't reintroduce `p.spinner()`.

## GitHub Actions runbook

The Action is the production runner. `.github/workflows/sync.yml`:

- **Triggers:** `schedule` (hourly `0 * * * *`) and `workflow_dispatch` (the
  manual **Run workflow** button / `gh workflow run`).
- **Steps:** checkout → install `ntn` (`curl -fsSL https://ntn.dev | bash`,
  pulls a linux-musl build to `/usr/local/bin`) → setup Bun → `bun install` →
  `bun run src/cli.ts sync`.
- **Why a PAT (`GH_PUSH_TOKEN`):** the job runs in *this* repo but pushes to a
  *different* repo (the target). The built-in `GITHUB_TOKEN` is scoped to the
  workflow's own repo, so it can't push cross-repo. Hence a PAT secret.

Run and watch it manually:

```bash
R=<owner>/<this-repo>  # e.g., your-org/notion-skills-github-sync
gh workflow run sync.yml --repo "$R"
id="$(gh run list --workflow sync.yml --repo "$R" --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$id" --repo "$R" --exit-status
gh run view "$id" --repo "$R" --log         # full logs if it fails
```

A healthy run ends in the Sync step with either `✓ Up to date — no commit
needed` (idempotent) or `✓ Committed <sha> to main`.

## Secrets & rotation

Repo **secrets** (Settings > Secrets and variables > Actions > Secrets):

| Secret | What | Scope needed |
|---|---|---|
| `NOTION_API_TOKEN` | Notion API token; `ntn` reads it from the env (overrides keychain). Must match the `notionEnv` in config.json. | read access to the skills DB |
| `GH_PUSH_TOKEN` | PAT / fine-grained token used to push to the target repo. | `contents:write` on the target repo |

### Setting secrets via CLI

You can set secrets using the GitHub CLI (`gh`), which is useful for automated
deployments or when an agent is setting up the repo:

```bash
REPO=<owner>/<this-repo>

# Set secrets (use --body to pass value, or pipe it in)
gh secret set NOTION_API_TOKEN --repo "$REPO" --body "$NOTION_API_TOKEN"
gh secret set GH_PUSH_TOKEN --repo "$REPO" --body "$GH_PUSH_TOKEN"
```

### Secret rotation

GitHub never lets you read a secret value back, so **rotation = re-set**. The
flow we use (keeps the value out of the terminal/argv and off disk afterward):

```bash
REPO=<owner>/<this-repo>
mkdir -p .secrets && : > .secrets/GH_PUSH_TOKEN   # .secrets/ is gitignored
# paste the token into the file, then:
printf %s "$(< .secrets/GH_PUSH_TOKEN)" | gh secret set GH_PUSH_TOKEN --repo "$REPO"
rm -rf .secrets
```

Validate a push token before relying on it:
`GH_TOKEN="$(< .secrets/GH_PUSH_TOKEN)" gh api repos/<owner>/<target-repo> --jq .permissions.push` → expect `true`.

When renaming/rotating: set the new secret **first**, confirm a green run, then
delete the old one — never leave a window where the workflow references a missing
secret.

## Local dev

Prereqs: [Bun](https://bun.sh) ≥ 1.2, the `ntn` CLI logged in to dev
(`ntn --env dev login`), and `gh auth login` (the GitHub client falls back to
`gh auth token` when `GITHUB_TOKEN` is unset).

```bash
bun install
cp config.json.example config.json  # fill in all non-secret settings
bun run dry-run                     # preview; pushes nothing
bun run sync                        # real sync to githubBranch
bun test                            # unit tests
bunx tsc --noEmit                   # typecheck
```

Notion reads go through `ntn` (it returns page bodies as Markdown directly).
Locally that uses your keychain auth; in CI it uses `NOTION_API_TOKEN`.

## Validation loop

What "done/verified" means here, in order:

1. `bunx tsc --noEmit` clean; `bun test` green (pure logic: slugify, convert,
   diff/idempotency, plan, updater).
2. `bun run dry-run` against the real DB shows the expected plan.
3. **Safe end-to-end:** point `githubBranch` at a throwaway branch first if needed,
   `bun run sync`, then verify with each client's validator (all three marketplace
   files should exist and list the same plugins):
   ```bash
   git clone <target-repo> /tmp/check && cd /tmp/check
   claude plugin validate .claude-plugin/marketplace.json --strict
   claude plugin validate plugins/<slug> --strict
   # Cursor + Codex marketplaces are emitted alongside Claude's:
   ls .cursor-plugin/marketplace.json .agents/plugins/marketplace.json
   CODEX_HOME=/tmp/codex-plugin-check codex plugin marketplace add /tmp/check
   ```
4. **Idempotency:** immediately re-run `sync` → expect `Up to date`, no commit.
5. **Prune:** uncheck a skill's `Published` in Notion → re-sync → its plugin +
   every client's marketplace entry are removed; non-managed plugins untouched.

Only sync to the real `main` once the throwaway-branch run looks right.

## Where do I change X?

| Goal | Touch |
|---|---|
| Retarget repo / branch / DB | `config.json` (commit the change) |
| Change how users pull tool updates | `src/update.ts` (`bun run update`) + `scripts/update-from-upstream.sh` (standalone, for pre-`.gitattributes` clones) + `.gitattributes` (`config.json merge=ours`) |
| **Switch prod → dev** (internal) | Set `notionEnv: "dev"` in config.json — flips *both* the `ntn` env and the injected updater's MCP URL (`mcp.notion.com` → `mcp-dev.notion.com`) **and** the connector's name/key (`notion` → `notion-dev`, so dev/prod connectors are distinguishable in the client). Also swap `NOTION_API_TOKEN` secret and data-source/database/change-requests ids in config.json to dev values, and make sure the dev DB has the `Published` checkbox (add via a data-source PATCH if it predates the guided setup). |
| Map a new Notion property | `src/notion/skill-schema.ts` (resolve it) + `src/convert.ts` (emit it) |
| Change skills schema / legacy-DB support | `src/notion/skill-schema.ts` — the ONE place property names/ids live; legacy support is the fenced `LEGACY_SHIM` block (see the note below before deleting it) |
| Move a customer off an old-schema DB | Done **in-product** now (Notion's "Turn into → Skills DB"); this tool no longer ships a `migrate` command. Just re-run `sync` afterwards — see the conversion gotcha below |
| Change skill file/zip handling | `src/files.ts` (pick/download/unzip) + `src/convert.ts` (`buildPluginFiles` overlay) + `src/plan.ts` (overlay prune) |
| Change the injected updater plugin | `src/updater.ts` (and `INJECT_SKILL_UPDATER` / `UPDATER_SLUG` to toggle/rename) |
| Add/change a supported client (manifest dir, marketplace path, entry shape) | `src/clients.ts` (the `CLIENTS` registry — the ONE place per-client differences live) |
| Change file/marketplace layout | `src/convert.ts` (paths, frontmatter) + `src/plan.ts` (merge/prune) + `src/clients.ts` (per-client marketplace paths/shapes) |
| Change GitHub write behavior | `src/github.ts` (Git Data API) + `src/plan.ts` |

## Architecture (pure core, thin edges)

```
src/
  cli.ts            commands: setup (guided, also --ci) | sync [--dry-run]
  config.ts         config.json -> Config
  wizard/           guided setup: steps/, crash-proof logger, spinner shim
  sync.ts           orchestration: Notion -> plan -> GitHub commit
  clients.ts        PURE: supported clients + their manifest conventions
  plan.ts           PURE: desired file set, prune set, per-client marketplace merges, injection
  convert.ts        PURE: page -> SKILL.md / plugin manifests / marker
  files.ts          skill zip attachment: pick / download / unzip
  diff.ts           PURE: git-blob-sha diffing / idempotency
  slugify.ts        PURE: name -> unique slug
  updater.ts        PURE: builds the injected notion-skill-updater plugin
  github.ts         GitHub Git Data API client (one atomic commit per sync)
  notion/
    types.ts        NotionClient interface  <-- swap-in seam for a REST adapter
    ntn.ts          low-level `ntn` invocation
    ntn-adapter.ts  NotionClient backed by the `ntn` CLI
    skill-schema.ts PURE: canonical typed-DB ids + legacy shim (resolve a row)
api/sync.ts         Vercel handler (scaffold; see limitations)
```

The `PURE` modules hold all the logic and are unit-tested; `ntn`/GitHub are thin
and swappable.

## Gotchas (these bit us — don't relearn them)

- **Typed skills DBs (`database_type: skills`).** Setup creates them via
  `POST /v1/tools/run` with `Notion-Version: 2026-03-11`, which answers with
  *Markdown*, not JSON — `parseTypedDbCreation` regex-parses the db url +
  `collection://` id, then a structured `GET /v1/databases/{id}` confirms them.
  Canonical property ids come back **URL-encoded** from the REST API
  (`notion%3A%2F%2Fskills%2Fdescription_property`) — always compare through
  `decodePropertyId`. The typed schema is a *minimum*: our `Published`/`Plugins`
  extras are PATCHed on afterwards. And workspace-level databases/pages cannot
  be trashed via the API ("Archiving workspace level pages via API not
  supported") — an API archive of such a DB degrades to a manual instruction.
- **In-product conversion ("Turn into → Skills DB") is the migration path, and
  sync just works after it — via the LEGACY_SHIM, not canonical-id detection.**
  Notion now converts an existing DB into a typed skills DB *in place*
  (notion-next PR #274889, gate `enable_agent_skills_v2`). Verified end-to-end
  (2026-07): the conversion **preserves the data source id** (so config.json
  needs no change), **preserves custom properties** (our `Published`/`Plugins`
  survive) and **page bodies** (where we read skill content), and only *adds* an
  empty `Files` property. Crucially, the REST API returns the converted DB's
  **original plain property ids** — NOT the canonical `notion://skills/*` ids —
  and exposes no `database_type` marker, so `isTypedSkillsDb` returns false and
  resolution falls through to the legacy display-name shim. This is the opposite
  of *freshly-created* typed DBs (our setup's `tools/run` path, and in-product
  fresh skill creation), which DO surface canonical ids. Consequence: the
  `LEGACY_SHIM` is **load-bearing for converted DBs** — don't delete it on the
  theory that "everyone migrated," and note that converted DBs are fragile to a
  user *renaming* the Skill name/Description/Created by columns (canonical-id
  resolution would survive a rename; the shim won't).

- **Setup-call gotchas live in `src/wizard/guidance.ts`.** These are the
  human-in-the-loop snags from real rollout calls, kept as pure string builders
  so they're reusable and unit-tested (`test/wizard-guidance.test.ts`): the two
  Notion admin settings that silently block setup ("Limit who can create
  personal access tokens" blocks `ntn login`; "Limit who can create internal
  connections" blocks the sync token — both at Admin Center → Connections →
  Manage, both fixable by an admin, and PAT creation can be re-restricted after
  setup); the org PAT-approval path (Organization Settings → Personal access
  tokens → Pending requests); and the Claude GitHub-app "Only select
  repositories" requirement for the private skills repo. If you touch this
  content, update the tests too.
- **Skills repo is always private; owners default to the org.** The decisions
  step no longer offers a public option, and repo-owner pickers list orgs first
  with an org as the default (personal account requires an explicit pick).
  Existing-repo reuse needs an explicit overwrite confirmation.
- **Marketplace manifest paths (one per client):** `.claude-plugin/marketplace.json`
  (Claude), `.cursor-plugin/marketplace.json` (Cursor), and
  `.agents/plugins/marketplace.json` (Codex) — **not** a root `marketplace.json`.
  (We shipped a stray root file once.) Every plugin dir also carries three
  per-plugin manifests (`.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`
  `plugin.json`) with **identical content** — only the location differs. The
  per-client differences (dir, marketplace path, entry shape) all live in
  `src/clients.ts`; the shared `plugin.json` bytes come from `buildPluginJson`
  in `src/convert.ts`, so updating shared metadata updates every manifest.
- **Workflow-registration race on a fresh sync repo.** GitHub registers
  workflows when it processes a push to the repo's *configured* default branch.
  Pushing a differently-named branch first (e.g. a feature branch to an empty
  repo) makes that branch the default only *after* the push is processed — so
  `sync.yml` sits on the default branch but `actions/workflows` stays empty and
  `gh workflow run` 404s ("workflow not found on the default branch"). Fix: push
  `HEAD:<configured default branch>` (the setup does this now, and polls
  `repos/<r>/actions/workflows/sync.yml` for `state: active` before dispatching).
  Manual recovery: push any commit to the configured default branch name.
- **Setup failures abort with a handoff prompt** (`src/wizard/handoff.ts`) —
  real failures in the deploy step never fall through to the happy-path wrapup.
  Skips (user answered "no") do continue. Keep it that way.
- **Marker = "managed by this tool".** Only plugins with a
  `.notion-sync.json` next to their `SKILL.md` are eligible for **pruning**.
  Hand-authored plugins and the injected updater have **no marker** and are never
  pruned. The updater must **stay** marker-less, or it'll be pruned every sync.
- **Dangling marketplace entries are NOT auto-healed.** If a plugin dir is
  deleted (e.g. by hand) but its entry remains in one of the marketplace files,
  the sync won't fix it — it only manages marker-bearing entries + its own
  injected/Notion entries, across all client marketplaces. We hit this with
  `hello-world` and fixed `marketplace.json` manually.
  (Candidate future improvement: drop entries whose `source` dir doesn't exist.)
- **Empty Notion `Description`** → the description is auto-derived from the first
  body line and a `⚠` is printed. Fill in `Description` in Notion for good agent
  routing.
- **`ntn` is the Notion layer.** It's the dependency that makes CI non-trivial
  (installed via `curl https://ntn.dev | bash`). It reads `NOTION_API_TOKEN` /
  `NOTION_ENV` from the environment.
- **Idempotency is via git blob sha**, and the marker's `contentHash` is stable
 across runs (excludes volatile fields), so unchanged skills produce no commit.
- **Skill files ride in a single zip on the `Files` property.** No zip is a
 perfectly normal state (a skill just has no extra files); `src/files.ts`'s
 `pickSkillZip` only resolves a zip when there's exactly one — anything else
 (no zip among loose files, more than one zip) silently doesn't resolve to one,
 no warning needed. When there is a zip, `src/sync.ts` downloads the signed
 URL, and `unzipSkillArchive` unpacks it (skipping dir
 entries, `__MACOSX`, `.DS_Store`, and unsafe `..`/absolute paths). The bytes
 flow through the pipeline as `FileContent = string | Uint8Array` (see
 `src/diff.ts`), so **file content is no longer text-only** — `gitBlobSha` and
 `github.createBlob` handle binary via `toBytes`. Zip the **contents at the
 root**, not a wrapping folder. The generated `SKILL.md`/marker always win over
 same-named zip entries (Notion is the source of truth for the body).
- **A managed skill dir owns its whole subtree.** `plan.ts` prunes any existing
 file under a live skill dir that isn't in this run's desired set, so shrinking
 or removing a zip cleans up the stale files. Don't hand-add files under a
 managed `skills/<slug>/` dir — they'll be pruned.

## The injected updater plugin

Every sync injects a synthetic `notion-skill-updater` plugin into the
marketplace (`src/updater.ts`). It bundles the **Notion MCP** (remote HTTP,
`mcp-<env>.notion.com/mcp`, OAuth prompted on first use) plus an auto-invoked
skill that teaches a client to edit/rename/create skills back in Notion (the
source of truth) — closing the write-back loop. It's not from Notion, so it
carries no marker and is re-asserted idempotently each run.

The skill tells the client to: (1) say up front that the change is saved **to
Notion** (where the skill lives, not the local files); (2) describe the change at
a high level and ask for an OK, offering to show the exact wording/diff on
request; and (3) when `changeRequestsDataSourceId` is set in config.json, offer a
**"propose a change"** path — instead of editing the skill page directly, it
creates a new page in the **Change Requests** data source, linked (via the
`Skill` relation) to the skill, with context + the proposed edit in the body and
Status left at `Proposed`. Downstream review/apply happens in Notion workflows.
Direct edit is the default; the propose option only renders when that config
field is set.

## Known limitations / future work

- **Vercel deploy is scaffolded but unverified** (`api/sync.ts`, `vercel.json`).
  It needs a direct-REST `NotionClient` (the `src/notion/types.ts` seam) because
  `ntn` isn't available in serverless runtimes and the Notion API host may not be
  reachable there.
- **No dangling-marketplace-entry self-heal** (see gotchas).
- **prod → dev migration** (internal Notion use) is a config flip + token/id swap (+ ensuring the dev DB has `Published`);
  prod is now the default for external users.
