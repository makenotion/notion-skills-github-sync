# CLAUDE.md — agent & maintainer notes

Operational + deployment context for this repo. The [README](./README.md) is the
generic, shareable description of the tool; **this file is the specifics of how
it's actually deployed and the hard-won gotchas.** Read both.

> One-line mental model: pull whole Agent Plugin directories from Notion's
> Plugins Public API → add Claude's compatibility manifest plus the client
> marketplace indexes → commit the whole set into GitHub on a schedule.

> **The sync reads Notion through the Plugins Public API** (`/v1/ai/plugins`
> to list, `/v1/ai/plugins/:id` to fetch a whole plugin), not the generic page
> API. **The plugin is the only unit that exists.** The API has no skill-level
> resource at all: the listing reports `{id, name, description, version_id}` and
> nothing more, and a plugin's skills are *whatever its archive contains*. So
> there is no skill list to reconcile against an archive, no per-skill id, and no
> per-skill version — caching, pruning, and identity are all per plugin. Notion
> still renders each `SKILL.md` (frontmatter and all), applies the description
> fallback, and bundles attachments. This tool's job is the *GitHub* half: plugin
> manifests, marketplace merges, pruning, and one atomic commit. Don't
> reintroduce page-property parsing here — if a field is missing, it belongs in
> the API.

> **The archive *is* the plugin directory.** An Agent Plugins 1.0 archive holds
> `skills/<dir>/…` under one wrapping directory; strip the wrapper and that
> subtree is exactly what gets published. The sync preserves the root
> `plugin.json`, derives `.claude-plugin/plugin.json` for Claude, adds one
> marker, expands lone per-skill zip attachments, and writes everything else
> through untouched. Cursor and ChatGPT/Codex consume the standard root manifest.

## Configuration overview

**Everything is an environment variable.** There is no committed config file:

- **local** — `.env` (gitignored; Bun loads it automatically)
- **CI** — repo **variables** for the non-secret settings, repo **secrets** for
  the two tokens (`NOTION_API_TOKEN`, `GH_PUSH_TOKEN`)

Why: several teams run copies of this same repo, and a committed `config.json`
made every copy diverge on exactly one file — which is also what made `update`
conflict on every merge. `.env` never participates in a merge.

`config.json` is **not read at all** any more — it is only *detected*, so a
deployment that never migrated (or only *partially* migrated) can't silently
run on defaults. Any key the file sets whose replacing variable is unset is a
hard error naming the mapping (`CONFIG_JSON_TO_ENV` in `src/config.ts`); a
leftover file whose settings are all migrated is just a warning telling you to
delete it. Either way the fix is `.env` / repo variables and
`git rm config.json`.

**GitHub rejects variable/secret names starting with `GITHUB_`**, so
`GITHUB_REPO`/`GITHUB_BRANCH` are stored as `SKILLS_GITHUB_*` variables and
mapped back in the workflow (`ciVariableName` in `src/config.ts`). Getting this
wrong looks like a workflow with no configuration at all.

See [`AGENTS.md`](./AGENTS.md) for AI agent setup.

## The `update` command

`bun run update` (`src/update.ts`) merges tool changes from the `upstream`
remote. It refuses on a dirty tree, and since config moved to `.env` there is no
per-file merge special case left — the prototype's `config.json merge=ours`
driver is gone.

`update --ci` is the auto-update path the workflow runs before each sync: it
creates the `upstream` remote if the checkout only has `origin`, merges, and
**pushes the result back to origin** so the team's repo actually tracks upstream.
The sync then runs on the merged code because it's a separate process started
afterwards. Failures are deliberately non-fatal in CI — a conflict aborts the
merge, an unreachable upstream is skipped, a failed push warns — because an
optional update must never stop the hourly sync. Accepted tradeoff: a bad
upstream commit reaches every team on the next run; pinning to tagged releases is
the gate to add if that bites.

Two CI requirements that are easy to miss: `actions/checkout` needs
`fetch-depth: 0` (a shallow clone cannot merge), and it must check out with
`GH_PUSH_TOKEN` — the default `GITHUB_TOKEN` cannot push a change that touches
`.github/workflows/**` without the `workflows` permission, and upstream updates
touch `sync.yml` regularly.

## Interactive setup

`bun run setup` is the deterministic, guided setup (formerly `wizard`). It's
structured to front-load all decisions and then run unattended, in six phases
(one file per phase in `setup/steps/`). It lives in the **top-level `setup/`
package**, separate from the sync core in `src/`, with its own
[README](./setup/README.md): the wizard shells out to the `ntn` and `gh` CLIs,
the sync is plain HTTPS, and the dependency runs one way — `setup/` may read
pure helpers out of `src/`, and the only thing pointing back is `src/cli.ts`
dispatching the command. Note it creates a **plain typed
Skills DB** — it no longer PATCHes on `Published`/`Plugins` properties, because
the Skills API the sync reads has no notion of either.

1. **Preflight** — tool checks + `ntn`/`gh` CLI auth (setup tooling only,
   never sync credentials). If `ntn login` fails, it re-verifies auth and, on
   failure, names the blocking Notion admin setting ("Limit who can create
   personal access tokens", Admin Center → Connections → Manage) rather than
   dying silently.
2. **Decisions** — every question, each with context, then ONE plan-summary
   confirm. The DB name isn't asked (auto: "Skills", renameable in Notion;
   `--db-name` overrides). Vocabulary used throughout: **Notion Skills DB**
   (source of truth), **skills repo** (plugins are published here; Claude reads
   it as a marketplace), **sync script repo** (this code; the
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
3. **Resources** — creates the Notion Skills DB (+samples via the
   shared `setup/skills-db.ts`, also used by `--ci`), the skills repo, and
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
   step also prints the setup-call gotchas inline (see `setup/guidance.ts`):
   the org PAT-approval path (Organization Settings → Personal access tokens →
   Pending requests) and the Notion "Limit who can create internal connections"
   admin setting.
5. **Deploy** — unattended tail: write `.env` → push sync script repo → secrets
   → repo variables (the non-secret settings; nothing is committed) → local test
   sync (run with the SAME dedicated tokens the workflow will use) → dispatch +
   watch a real Actions run. It also asks, in the decisions phase, whether to
   enable auto-update (default **on**), and stores that as `AUTO_UPDATE`.
6. **Wrap-up** — register-the-marketplace steps (Organization settings →
   Plugins) with a done-confirm to pace the output, then a short summary and
   an offer to open the Skills DB. Also prints the Claude GitHub-app gotcha:
   a private skills repo won't appear in Claude's picker unless the org's
   Claude GitHub app (if set to "Only select repositories") is granted access
   to it, and the repo is visible to whoever does the Claude-side setup.

- **Runs against prod by default.** Dev is opt-in with `bun run setup --env dev`
  (internal Notion use). The chosen env is threaded through *every* Notion
  call and written to `.env` as `NOTION_ENV` — so the database is created in the
  same env the sync later reads from. (Getting these out of sync is what produced
  a `404 object_not_found` at the test-sync step: DB created in dev, sync
  configured for prod.)
- **Test runs:** `bun run setup --test-run` (interactive only) runs the whole
  real setup, then adds a final cleanup step (`setup/steps/cleanup.ts`)
  that offers to delete the GitHub repos the run created (`gh repo delete`,
  with a `gh auth refresh -h github.com -s delete_repo` hint if the scope is
  missing) and restores the rewired git remotes (`upstream` → `origin`).
  Pre-existing repos the user chose to reuse are never deleted; the Notion
  Skills DB is left for the user to trash in Notion.
- **Non-interactive:** `bun run setup --ci` (for agents/CI) — see
  `setup/non-interactive.ts`. Also honors `--repo`, `--db-name`,
  `--db-parent-page`. CI mode doesn't push the sync script repo or dispatch
  Actions, and takes credentials from the environment instead of the
  dedicated-token checkpoint.
- **Diagnostic log:** every run writes a JSONL log to
  `.notion-sync-setup/setup-<ts>.log.jsonl` (gitignored). It's crash-proof (one
  JSON object per line, flushed as it goes, with a `crash` record + stack on
  failure) and **redacts tokens**. Share/read this file to debug a stuck setup.
- Setup's spinners are a local shim (`setup/spinner.ts`), not
  `@clack`'s — clack's spinner grabs stdin via `block()`, which could
  `process.exit(0)` on a stray escape/empty keypress. The shim never touches
  stdin, so that whole failure mode is gone. Don't reintroduce `p.spinner()`.

## GitHub Actions runbook

The Action is the production runner. `.github/workflows/sync.yml`:

- **Triggers:** `schedule` (hourly `0 * * * *`) and `workflow_dispatch` (the
  manual **Run workflow** button / `gh workflow run`).
- **Steps:** checkout (full history, push token) → setup Bun → `update --ci`
  (unless the `AUTO_UPDATE` variable is `false`) → `bun install` →
  `bun run src/cli.ts sync`.
  No CLI install step: the sync is plain HTTPS on both ends now (Notion Skills
  API + GitHub Git Data API). The old `curl -fsSL https://ntn.dev | bash` step
  is gone — `ntn` is only used by `setup`, which never runs in CI.
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

- **Secrets alone are not enough — the non-secret settings are repo
  *variables*, and forgetting them is silent until the run.** After the move off
  `config.json` the deployment kept its two secrets and had *no* variables, so
  every hourly run failed with `✖ Missing GITHUB_REPO` (2026-08-10). The Sync
  step's `env:` block echoes every setting, so a log full of `KEY:` with empty
  values is the tell. `gh variable list --repo "$R"` is the check, and
  `.env.example` is the full list of names to set.
- **`timeout-minutes` is sized for a *cold* sync, not a warm one.** The sync
  commits once, at the end, so a run killed partway writes nothing — set the
  ceiling too low against a cold target and no number of hourly retries will
  ever converge. It was 15 while a cold sync took ~45 min; it is now 45 while a
  cold sync takes ~4.

## Secrets & rotation

Repo **secrets** (Settings > Secrets and variables > Actions > Secrets):

| Secret | What | Scope needed |
|---|---|---|
| `NOTION_API_TOKEN` | Notion API token, read directly by the sync's HTTP client. Must match `NOTION_ENV`. **Required for local runs too** — there is no `ntn` keychain fallback. | read content on the skills |
| `GH_PUSH_TOKEN` | PAT / fine-grained token used to push to the target repo, and (with auto-update on) to push merged updates to this repo. | `contents:write` on the target repo; `contents:write` + `workflows:write` on this repo |

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

Prereqs for **sync**: [Bun](https://bun.sh) ≥ 1.2, `NOTION_API_TOKEN` in the
env or `.env`, and `gh auth login` (the GitHub client falls back to
`gh auth token` when `GITHUB_TOKEN` is unset). The `ntn` CLI is only needed for
`setup` (`ntn --env dev login`).

```bash
bun install
cp .env.example .env                # fill in settings + tokens
bun run dry-run                     # preview; pushes nothing
bun run sync                        # real sync to GITHUB_BRANCH
bun test                            # tests
bunx tsc --noEmit                   # typecheck
```

Notion reads are plain HTTPS against the Plugins API and always use
`NOTION_API_TOKEN` — the same code path locally and in CI. There is **no
keychain fallback** any more: a local run without the token fails immediately
with a message saying so.

## Validation loop

What "done/verified" means here, in order:

1. `bunx tsc --noEmit` clean; `bun test` green. The suite is mostly **end to
   end**: `test/fake-skills-api.ts` is an in-memory Plugins API served through the
   real client (genuine whole-plugin `.tar.gz` fixtures, pagination, 429s), and
   `src/target/memory.ts` is the other end, so `test/sync-e2e.test.ts` asserts on
   observable behaviour — resulting file tree, commit count, prune results,
   marketplace contents for all three clients, idempotency. Unit tests are kept
   only where the logic is intricate and general: untar, blob sha, slug
   assignment, retry-delay math, tree chunk boundaries, host resolution, config
   loading, and `update`'s git behaviour (real temp repos). Setup has its own
   suite under `setup/test/`.
   **Keep the fake's response shapes honest.** The suite stayed green through the
   2026-08-10 API change purely because the fake still served the old listing
   with a nested `skills[]`; production had dropped it and every real sync
   returned zero skills. A green suite is not evidence the reader matches the
   API — dry-run against a real workspace before believing it.
2. `bun run dry-run` against the real workspace shows the expected plan.
3. **Safe end-to-end:** point `GITHUB_BRANCH` at a throwaway branch first if needed,
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
4. **Idempotency:** immediately re-run `sync` → expect `Up to date`, no commit,
   and every plugin listed under `unchanged` in the plan (the `version_id` fast
   path: no archive was downloaded at all — one list call for the whole run).
   Also worth running once per change to `update`: a merge against a
   deliberately dirty tree (should refuse) and an `update --ci` run in CI.
5. **Prune:** delete a plugin in Notion (or revoke the connection's access to
   it) → re-sync → its whole directory and marketplace entry are removed. To
   check exact replacement, remove a file from a plugin in Notion and verify the
   next plugin version deletes that file from the target branch.

Only sync to the real `main` once the throwaway-branch run looks right.

## Where do I change X?

| Goal | Touch |
|---|---|
| Retarget repo / branch | `GITHUB_REPO` / `GITHUB_BRANCH` (`.env` locally, `SKILLS_GITHUB_*` repo variables in CI) |
| Rename a published plugin directory | Rename the plugin **in Notion** — directory names are slugified from the API's plugin names. The old directory is pruned on the next sync. `PLUGIN_SLUG` is only the fallback for an unnamed plugin |
| **Switch prod → dev** (internal) | Set `NOTION_ENV=dev` — every host comes from `src/notion/env.ts`, so this flips the Plugins API host (`api.notion.com` → `api-dev.notion.com`), the app host in marker URLs, the injected updater's MCP URL, and the connector's name/key (`notion` → `notion-dev`) together. Also swap `NOTION_API_TOKEN` and the data-source/database/change-requests ids to dev values (those ids are only used for the marker + updater guidance, not for reading plugins) |
| Surface a new plugin field | Nothing here — it has to come from the Plugins API. Add it to `Plugin` in `src/notion/plugins.ts` once the API returns it, then emit it in `src/sync/plan.ts`. **There is no skill-level field to surface**: skill metadata only exists inside `SKILL.md`, which Notion renders |
| Move a customer off an old-schema DB | Done **in-product** (Notion's "Turn into → Skills DB"). The Plugins API only reports typed skills, so conversion is now a hard prerequisite rather than a nicety — see the gotcha below |
| Change archive handling | `src/notion/archive.ts` (extract/zip-expansion) + `src/notion/untar.ts` (tar reader) + `src/sync/plan.ts` (subtree prune). Downloading is `NotionHttp.fetchBytes`, so it retries |
| Speed up / throttle a cold sync | `SYNC_CONCURRENCY` (default 8; `.env` locally, repo variable in CI) — applies to Notion archive fetches only, never GitHub writes |
| Change retry behavior | `src/notion/http.ts`: `retryDelayMs` (error responses) and `transportRetryDelayMs` (a `fetch` that throws). Both flow through the one `send` loop |
| Change the injected updater plugin | `src/sync/updater.ts` (and `INJECT_UPDATER` / `UPDATER_SLUG` to toggle/rename) |
| Add/change a supported client (manifest dir, marketplace path, entry shape) | `src/sync/clients.ts` (the `CLIENTS` registry — the ONE place per-client differences live) |
| Change file/marketplace layout | `src/sync/plan.ts` (paths, manifests, marker, merge/prune) + `src/sync/clients.ts` (per-client marketplace paths/shapes). **Neither `SKILL.md` nor the `skills/` layout is ours** — both arrive from the API |
| Change GitHub write behavior | `src/target/github.ts` (Git Data API + the `SyncTarget` impl) |
| Publish somewhere other than GitHub | Implement `SyncTarget` (`src/target/target.ts`); `src/target/memory.ts` is the reference. Nothing in `src/sync/` needs to change |
| Add a Notion endpoint | `src/notion/` — `plugins.ts` for resources, `http.ts` for the transport (auth is the client's `auth` option), and export it from `index.ts` |
| Change what `update` does | `src/update.ts` + the auto-update step in `.github/workflows/sync.yml` |
| Change the guided setup | `setup/` — its own top-level package: `steps/` (one file per phase), `non-interactive.ts` for `--ci`, and `setup/README.md` |

## Architecture (three layers, one boundary each)

The organising idea: **talking to Notion's Plugins API** (reusable by anyone) is
separate from **publishing a plugin marketplace** (our application), which is
separate from **where the files go** (the target).

```
src/
  cli.ts            commands: setup [--ci] | sync [--dry-run] | update [--ci]
  config.ts         environment -> Config (a leftover config.json is detected,
                    never read)
  wire.ts           assemble a NotionClient + GitHubTarget from a Config
  update.ts         merge tool changes from `upstream` (+ the CI auto-update path)
  notion/           <- REUSABLE: reading plugins out of Notion. Single entry point.
    index.ts        NotionClient; the one import a consumer needs
    env.ts          host resolution (api / app / mcp) for prod | dev | stg
    http.ts         transport: auth header, retries, typed NotionApiError
    plugins.ts      /v1/ai/plugins, /v1/ai/plugins/:id (+ plugins.files(): the
                    whole-plugin archive, extracted). No skill-level resource.
    archive.ts      signed URL -> tar.gz -> the files a plugin dir should hold;
                    strips the wrapper, expands a lone attachment zip per skill
    untar.ts        PURE: minimal tar reader (ustar + PAX + GNU long names)
  sync/             <- OUR APPLICATION: plugins -> plugin marketplace
    engine.ts       orchestration; target-agnostic (incl. resolvePlugin: the
                    per-plugin version_id download-skip decision)
    plan.ts         PURE: plugin paths, derived Claude manifest, the sync marker,
                    desired file set, plugin-level prune set, marketplace merges
    clients.ts      PURE: supported clients + their marketplace conventions
    updater.ts      PURE: builds the injected notion-skill-updater plugin
    slugify.ts      PURE: name -> unique slug (dedupes API kebab-case collisions)
    pool.ts         PURE: bounded-concurrency map (the cold-sync archive fetches)
  target/           <- WHERE IT LANDS
    target.ts       SyncTarget + content ids (git blob sha) + computeChanges
    github.ts       Git Data API client + GitHubTarget (one atomic commit/sync)
    memory.ts       in-memory target: the reference impl, and what tests run on
setup/              <- SEPARATE PACKAGE: the one-time guided rollout. steps/ (one
                    file per phase), non-interactive.ts (--ci), the `ntn`/`gh`
                    plumbing, crash-proof logger, spinner shim. See its README;
                    only cli.ts imports it, and only to dispatch `setup`.
```

**`SyncTarget` is the load-bearing boundary.** The engine says "here is the
desired set of files and their content ids"; a GitHub target commits them, an
in-memory target records them, a filesystem target would write them. The
`version_id` caching protocol is identical for all of them — which is what lets
the test suite run a whole sync with no network on either side.

Two constraints on `notion/` worth preserving:

1. **Single export surface.** A consumer imports `NotionClient` from
   `src/notion/index.ts` and gets the whole capability; they should never have to
   assemble five modules in the right order.
2. **Match `@notionhq/client`'s conventions** (verified against 5.23.3), on the
   assumption the SDK may absorb these capabilities: a `{ auth, baseUrl,
   notionVersion, fetch, retry }` constructor, namespaced resource methods taking
   argument objects, an error type carrying Notion's own `code`, and the standard
   `has_more`/`next_cursor` envelope (followed for you by `plugins.listAll()`,
   the only paginated call there is). One deliberate divergence:
   back-off here is deterministic (no jitter) — a single scheduled job has no herd
   to avoid, and it makes the retry math directly testable.

The `PURE` modules hold the logic and are covered by the end-to-end suite plus
targeted unit tests; the network edges are thin and swappable.

## Gotchas (these bit us — don't relearn them)

- **Typed skills DBs (`database_type: skills`).** Setup creates them via
  `POST /v1/tools/run` with `Notion-Version: 2026-03-11`, which answers with
  *Markdown*, not JSON — `parseTypedDbCreation` regex-parses the db url +
  `collection://` id, then a structured `GET /v1/databases/{id}` confirms them.
  Canonical property ids come back **URL-encoded** from the REST API
  (`notion%3A%2F%2Fskills%2Fdescription_property`) — always compare through
  `decodePropertyId`. The typed schema is now used **as-is** — setup no longer
  PATCHes on `Published`/`Plugins` extras (see the Skills API note below). And
  workspace-level databases/pages cannot be trashed via the API ("Archiving
  workspace level pages via API not supported") — an API archive of such a DB
  degrades to a manual instruction.
- **Conversion to a typed Skills DB is now a hard prerequisite, not a nicety.**
  Notion converts an existing DB into a typed skills DB in place via "Turn into
  → Skills DB" (notion-next PR #274889, gate `enable_agent_skills_v2`). The
  Skills API only reports rows backed by a **live skill prompt** — an untyped
  DB of "skill-ish" pages is invisible to it and syncs as zero skills. Under
  the old page-API reader we papered over untyped/renamed schemas with a
  display-name shim (`skill-schema.ts`'s `LEGACY_SHIM`); **that whole layer is
  deleted.** If a customer's skills don't show up, the first thing to check is
  whether their DB is actually typed — not whether we're resolving properties
  right, because we no longer resolve properties at all. The upside: renaming
  the Skill name / Description columns can no longer break the sync.

- **Setup-call gotchas live in `setup/guidance.ts`.** These are the
  human-in-the-loop snags from real rollout calls, kept as pure string builders
  so they're reusable and unit-tested (`setup/test/setup-guidance.test.ts`): the two
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
  (We shipped a stray root file once.) Cursor and Codex consume each plugin's
  standard root `plugin.json` directly. Claude also gets
  `.claude-plugin/plugin.json`, derived from that root manifest by preserving its
  fields and filling only Claude's missing `version`, `description`, and `author`
  metadata. The marketplace entry differences live in `src/sync/clients.ts`.
- **Workflow-registration race on a fresh sync repo.** GitHub registers
  workflows when it processes a push to the repo's *configured* default branch.
  Pushing a differently-named branch first (e.g. a feature branch to an empty
  repo) makes that branch the default only *after* the push is processed — so
  `sync.yml` sits on the default branch but `actions/workflows` stays empty and
  `gh workflow run` 404s ("workflow not found on the default branch"). Fix: push
  `HEAD:<configured default branch>` (the setup does this now, and polls
  `repos/<r>/actions/workflows/sync.yml` for `state: active` before dispatching).
  Manual recovery: push any commit to the configured default branch name.
- **Setup failures abort with a handoff prompt** (`setup/handoff.ts`) —
  real failures in the deploy step never fall through to the happy-path wrapup.
  Skips (user answered "no") do continue. Keep it that way.
- **A repo variable may not be named `GITHUB_*`.** GitHub rejects both secrets
  and variables starting with that prefix, so the two settings that would collide
  live as `SKILLS_GITHUB_REPO` / `SKILLS_GITHUB_BRANCH` and the workflow maps them
  into `GITHUB_REPO` / `GITHUB_BRANCH`. `ciVariableName` in `src/config.ts` is the
  one place that knows this. Skip the mapping and the workflow silently runs with
  no target repo configured.
- **Auto-update needs a PAT, not the default `GITHUB_TOKEN`.** The default token
  cannot push a change that touches `.github/workflows/**` (that needs the
  `workflows` permission), and upstream updates touch `sync.yml` regularly — so
  `actions/checkout` must use `GH_PUSH_TOKEN`. It also needs `fetch-depth: 0`,
  because a shallow clone cannot merge. Both are in `sync.yml`; both fail in ways
  that look unrelated to updating.
- **CI-mode `update` failures are non-fatal on purpose.** A conflict aborts the
  merge, an unreachable upstream is skipped, a rejected push warns — and the sync
  still runs. An optional update must never take out the hourly sync, and a
  half-merged runner checkout is worse than an un-updated one.
- **The engine must never learn about GitHub.** `SyncTarget` (`src/target/`) is
  the only write path; `src/sync/` gets a `contentId` function and an `apply`, and
  that's it. The moment the engine reaches for a blob sha or a branch name, the
  in-memory target stops being able to stand in for GitHub and the end-to-end
  suite loses its point.
- **The Notion half must stay importable on its own.** Nothing under
  `src/notion/` may import from `src/sync/`, `src/target/`, or `src/config.ts` —
  it's the reusable half, and a consumer should be able to copy the directory out.
  The dependency runs one way only.
- **Notion is the sole source of `pluginsDir`, and the sync owns all of it.**
  Any directory under `plugins/` that a run didn't produce is pruned, and each
  client's marketplace `plugins` array is *replaced*, not merged. There is no
  carve-out for hand-authored plugins — don't put anything there by hand. The
  injected updater survives only because it's in `desiredSlugs`, so turning
  `INJECT_UPDATER` off correctly removes it. (We used to gate pruning on the
  `.notion-sync.json` marker; that protected hand-authored plugins nobody was
  using, and left dangling marketplace entries un-healable — we hit that with
  `hello-world` and had to fix `marketplace.json` by hand. Both are gone.)
- **One minimal marker per plugin, at the plugin root.**
  `plugins/<slug>/.notion-sync.json` carries the plugin's identity, `version_id`,
  source context, and target slug. There is no skill inventory and no per-skill
  marker: the plugin is opaque. A byte-identical marker is the warm-cache key.
  The sync deliberately does not inspect an unchanged plugin for repo drift;
  its directory is replaced the next time its Notion version changes.
- **A marketplace's non-plugin top-level keys are preserved.** `name`, `owner`,
  `description` and anything else at the root of a marketplace manifest survive
  every sync — that's the repo's own identity, and nothing in Notion supplies
  it. Only the `plugins` array is ours.
- **There is no `Published` flag any more, and no per-skill opt-out.**
  `/v1/ai/plugins` returns *every* live plugin in the bot's workspace that
  the token can read; the API has no row-level publish filter and we deliberately
  don't reimplement one (that would mean going back to querying the data source,
  which is the thing we removed). **Publishing control is now access control:**
  what syncs is exactly what the Notion connection has been granted. Scope the
  connection, not a checkbox.
- **The routes moved twice and the listing was hollowed out; skills stopped
  being addressable at all.** Routes were `/v1/skills/plugins` +
  `/v1/skills/directories/:id` until 2026-07, then `/v1/ai/plugins` +
  `/v1/ai/skills/:id`. With Agent Plugins 1.0 (2026-08) the per-skill archive
  endpoint was retired — `/v1/ai/skills/:id` answers `400 invalid_request_url` —
  and on **2026-08-10** the listing **dropped its nested `skills[]` array**. It
  now returns `{id, name, description, version_id}` and nothing else. There is no
  replacement: `/v1/ai/skills` and `/v1/ai/plugins/:id/skills` both 400, and
  `?include=skills` / `?expand=skills` are ignored. **The archive is the only
  source of a plugin's skills** — that is why caching is per plugin and why the
  code has no skill list to reconcile. A stale route is a *routing* failure
  (`400 invalid_request_url`), which looks nothing like the 403 from the feature
  gate; if every call suddenly 400s, suspect a route rename first. The list is
  still Notion's standard paginated envelope (`results` +
  `has_more`/`next_cursor` — the server ignores `page_size` but emits a cursor,
  so `list` follows it).
- **Plugin grouping comes from the API, and the grouping is fine-grained.**
  `/v1/ai/plugins` reports one plugin per skills grouping. As of 2026-08-10 that
  is **420 plugins in dev**: a few real team groupings ("Finance", "EPD") and
  several hundred one-skill plugins. The old built-in `notion-workspace-skills`
  plugin (362 skills in one archive) is **gone** — those skills now arrive as
  their own plugins. Each becomes its own directory under `pluginsDir`, named by
  slugifying the plugin's name (`assignUniqueSlugs`, so a duplicate name gets
  `-2`). Two consequences: **(1)** a cold sync now makes ~420 archive requests
  instead of ~4, which is the dominant cost of a first run (fetched
  `SYNC_CONCURRENCY` at a time — see "cold sync" below); **(2)** skill directory
  names come from the archive and are
  only unique *within* a plugin, so the same skill title in two plugins is fine
  and the sync never re-slugs them. `config.pluginSlug` is only the fallback base
  for a plugin the API returns with an empty name.
- **The endpoints are feature-gated (`public_api_skills_plugins`).** A workspace
  without the gate gets `403 restricted_resource` / "Endpoint unavailable." —
  the *same* response as a token missing read access, which is why
  the hints in `src/notion/plugins.ts` name both causes. If the sync 403s on a
  workspace that used to work, check the gate before suspecting the token.
- **`ntn` is setup-only, and now structurally so.** Every `ntn` invocation lives
  in `setup/ntn-cli.ts` (typed-DB creation via `tools/run`, file uploads); there
  is no `ntn` code under `src/` at all, so the sync path cannot reach for it.
  That's what keeps CI free of the `curl https://ntn.dev | bash` step.
- **A plugin directory name must be a function of identity, not list position.**
  `slugify` is ASCII-only, so a fully non-Latin name flattens to `""` — 7 of dev's
  420 plugins have Japanese names, and another 19 come back with no name at all,
  so **26 plugins have no usable slug**. Letting `assignUniqueSlugs` separate them
  positionally (`skills-2`, `skills-3`, …) is unstable: delete one plugin and every
  later one slides onto a different directory, so the next sync rewrites and prunes
  subtrees that never changed — hundreds of files of pure churn. `fallbackName` in
  `engine.ts` therefore suffixes the plugin's own id (`skills-3b4b35e6`). Ugly,
  stable, traceable.
  **Still open:** two plugins with the *same real name* (13 such pairs in dev,
  e.g. two "Reformat") are still separated positionally, so which one owns
  `reformat` vs `reformat-2` depends on listing order. Fixing that means renaming
  directories in existing deployments, so it wasn't done here. If you do it, the
  id suffix is the same answer.
- **The listing and the archive route disagree, and that exact 404 must not sink the
  run.** `/v1/ai/plugins` can list a plugin that `/v1/ai/plugins/:id` then answers
  `404 directory_not_found` ("not shared by the connected workspace") — seen on
  `html explain diff` in dev, 2026-08-10. Letting that abort the run discards
  the whole cold sync's work; the first real cold sync died on plugin ~283 of
  420. So `resolvePlugin` catches only
  `404 directory_not_found` and retains an existing copy. A plugin that has never
  downloaded is omitted rather than listed broken. Every other failure — auth,
  feature gate, exhausted server retries, signed-download failure, corrupt
  archive — aborts the run. A plugin whose access is genuinely revoked drops out
  of the *listing*, and that is what prunes it.
- **Retries must cover a `fetch` that *throws*, not just one that answers
  badly.** A cold sync is hundreds of requests over minutes, so a dropped
  socket is routine: the first parallel CI run died 52 archives in with "The
  socket connection was closed unexpectedly". That is not an HTTP status, so a
  status-only retry never sees it. Two rules fall out, both encoded in
  `NotionHttp.send`: **(1)** a throw retries only for idempotent methods — a GET
  that died in transit can be reissued, a POST may already have been applied;
  **(2)** the body read happens *inside* the retry, because a connection that
  dies mid-transfer throws from `arrayBuffer()` long after the headers arrived —
  retrying only the initial `fetch` would miss exactly the case that bit us.
  Archive downloads go through `fetchBytes` for this reason; there is
  deliberately no non-retrying download helper left to reach for.
- **Never write one blob per file — GitHub's secondary limit will kill a cold
  sync.** The ceiling is [80 content-creating requests/minute and 500/hour](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api);
  a cold sync of the dev workspace needs ~830 files, so `POST /git/blobs`
  per file *cannot* fit in an hour no matter how you pace it. (We learned this
  the hard way: 826 blobs, 403 at roughly the 500 mark, four minutes of Notion
  work discarded.) Instead `sync.ts` puts UTF-8 files inline in the tree
  request via `isInlineableText` and only blobs true binaries — 22 blobs + 4
  tree chunks + commit + ref = **28 requests** for the same 826 files. Tree
  entries have no base64 option, which is the whole reason binary is split out.
  `gh.buildTree` chunks at 300 entries / 3MB (limit is 100k / ~7MB), chaining
  each chunk as the next `base_tree`.
  **Corollary: parallelizing GitHub writes is the wrong instinct** — the
  constraint is request *count*, not latency, so concurrency makes it worse.
  The Notion side is the opposite (latency-bound), so the two halves need
  opposite treatments.
- **The cold path is user-triggerable, not just a first-run event.** Plugin
  directory names come from the API's plugin names, so *renaming a plugin in
  Notion* rewrites that plugin's whole subtree — 724 files for
  `notion-workspace-skills`. Same for adding a plugin or changing the marker
  format. Any change to what the marker contains re-writes every skill.
- **The `version_id` fast path compares blob shas, not file contents.**
  `resolvePlugin` hashes the marker it *would* write and compares against the
  base tree already in memory. It must stay that way: reading markers back would
  be one GET per plugin, which at ~420 plugins is the entire cost of an otherwise
  no-op hourly run. Everything needed is in the `existing` map. Comparing the
  whole marker's sha (rather than just `version_id`) is deliberate — it also
  catches renames, config changes, and marker-format changes. It does not inspect
  the files inside an unchanged plugin.
- **Idempotency is via git blob sha.** On top of that, the marker embeds the
  API's `version_id`, so `resolvePlugin` compares the marker it *would* write
  against the repo's copy and skips the archive download entirely when they
  match. Building an archive is expensive server-side (render + fetch attachments
  + upload), so keep this fast path working. Note the granularity tradeoff that
  came with per-plugin caching: **any** change inside a plugin re-downloads the
  whole plugin. That is cheap for the one-skill plugins the API now mostly
  returns, and byte-identical siblings still produce no writes, so the commit
  stays minimal even when the download isn't.
- **Two archive formats, one inside the other — this confuses everyone once.**
  The *envelope* is tar: the Plugins API delivers a whole plugin as a `.tar.gz`
  (you can see it in the signed URL). Inside, each skill sits under
  `skills/<dir>/`, and a skill's *payload* may itself be a zip: whatever the
  author attached to the Notion page's `Files` property, usually a `.zip`
  because that's what you get when you compress a folder. So the sync untars the
  envelope (`untar.ts`) and otherwise preserves the plugin opaquely. The only
  content-aware step is locating each immediate `skills/<dir>/` directory and
  unzipping its lone root attachment (`unzipSkillArchive`, via `fflate`). Tar is
  Notion's transport; zip is the user's attached payload.
- **A plugin arrives as one `.tar.gz`, and the tar reader is ours.**
  `src/notion/untar.ts` is a hand-rolled reader because Node has no untar and the
  stream libraries pull a dep tree. It must handle **PAX extended headers** —
  `tar-stream` (what the server uses) emits one for *any* entry name that is
  non-ASCII or over 100 bytes, which is routine for Notion page titles and the
  API's 200-byte attachment names. Don't "simplify" it down to plain ustar.
- **A lone attachment `.zip` is still expanded in place.** The API archives an
  attached zip verbatim rather than unpacking it, so each skill bucket from
  `extractPluginArchive` expands it when there's exactly one — otherwise a
  skill's `scripts/` and
  `assets/` folders would ship as an opaque zip. Anything else (no zip, several
  zips) is left as delivered. Zip the **contents at the root**, not a wrapping
  folder. The API-rendered `SKILL.md` wins over a same-named zip entry. Bytes
  flow through as `FileContent = string | Uint8Array` (see
  `src/target/target.ts`) — `gitBlobSha` and `createBlob` handle binary via
  `toBytes`.
- **Pruning is two rules, and a retained plugin is in neither.** `plan.ts`: (1)
  a plugin directory this run didn't publish is deleted whole; (2) a plugin we
  *did* download owns its subtree, so any file under it that isn't desired is
  deleted — which is how a dropped skill or attachment cleans up. A *retained*
  plugin (version_id matched, nothing downloaded) contributes **no desired
  files**, so it must be excluded from rule 2 or the fast path would delete
  everything it was meant to leave alone. It survives rule 1 by being in
  `desiredSlugs`. See the "re-running a sync" and "pruning" tests in
  `test/sync-e2e.test.ts`. Don't hand-add files under a managed plugin dir: a
  cached plugin is not inspected, but its next Notion version replaces the whole
  directory and removes anything absent from the archive.

## The injected updater plugin

Every sync injects a synthetic `notion-skill-updater` plugin into the
marketplace (`src/sync/updater.ts`). It bundles the **Notion MCP** (remote HTTP,
`mcp-<env>.notion.com/mcp`, OAuth prompted on first use) plus an auto-invoked
skill that teaches a client to edit/rename/create skills back in Notion (the
source of truth) — closing the write-back loop. It's not from Notion, so it
carries no marker and is re-asserted idempotently each run.

The skill tells the client to: (1) say up front that the change is saved **to
Notion** (where the skill lives, not the local files); (2) describe the change at
a high level and ask for an OK, offering to show the exact wording/diff on
request; and (3) when `CHANGE_REQUESTS_DATA_SOURCE_ID` is set, offer a
**"propose a change"** path — instead of editing the skill page directly, it
creates a new page in the **Change Requests** data source, linked (via the
`Skill` relation) to the skill, with context + the proposed edit in the body and
Status left at `Proposed`. Downstream review/apply happens in Notion workflows.
Direct edit is the default; the propose option only renders when that config
field is set.

## Known limitations / future work

- **GitHub Actions is the only runner.** An unverified Vercel handler used to sit
  in `api/`; it was deleted rather than carried. Nothing blocks another host —
  the sync is plain HTTPS on both ends and needs only `NOTION_API_TOKEN` +
  `GITHUB_TOKEN` — but whoever adds one has to confirm the Notion API host is
  reachable from it (the dev workspace in particular may not be).
- **No per-skill publish control** (see gotchas) — access to the Notion
  connection is the only lever. If customers need finer control, it has to come
  from the Plugins API, not from this tool.
- **prod → dev migration** (internal Notion use) is a `NOTION_ENV` flip + token swap;
  prod is now the default for external users.
- **Cold-sync archive fetches are parallel; GitHub writes are not.** This
  asymmetry is deliberate and easy to get backwards. The Notion half is
  *latency*-bound — one `/v1/ai/plugins/:id` + one download per plugin, each
  waiting on a server-side render — so `mapPool` (`src/sync/pool.ts`) runs
  `SYNC_CONCURRENCY` (default 8) at a time. Measured 2026-08-11 on dev's 424
  plugins: **45 min serial → 3m50s locally, 4m14s in CI**, with 1–3 requests
  rate-limited per run and absorbed by the back-off. The GitHub half is
  *request-count*-bound, so parallelizing it makes things strictly worse (see
  the blob-limit gotcha). Warm runs touch neither path — one list call, no
  downloads, ~25s.
