# CLAUDE.md — agent & maintainer notes

Operational + deployment context for this repo. The [README](./README.md) is the
generic, shareable description of the tool; **this file is the specifics of how
it's actually deployed and the hard-won gotchas.** Read both.

> One-line mental model: pull rendered skill directories from Notion's Skills
> Public API → wrap them in Claude Code, Cursor, and Codex plugin manifests →
> commit the whole set into a GitHub repo that's a multi-client plugin
> marketplace, on a schedule.

> **The sync reads Notion through the Skills Public API** (`/v1/ai/plugins`
> and `/v1/ai/skills/:id`), not the generic page API. Notion renders
> `SKILL.md` (frontmatter and all), applies the description fallback, bundles
> the page's attachments, and hands back a `.tar.gz` plus an opaque
> `version_id`. This tool's job is the *GitHub* half: plugin manifests,
> marketplace merges, pruning, and one atomic commit. Don't reintroduce
> page-property parsing here — if a field is missing, it belongs in the API.

## Configuration overview

**Everything is an environment variable.** There is no committed config file:

- **local** — `.env` (gitignored; Bun loads it automatically)
- **CI** — repo **variables** for the non-secret settings, repo **secrets** for
  the two tokens (`NOTION_API_TOKEN`, `GH_PUSH_TOKEN`)

Why: several teams run copies of this same repo, and a committed `config.json`
made every copy diverge on exactly one file — which is also what made `update`
conflict on every merge. `.env` never participates in a merge.

`config.json` is still read as a **deprecated fallback** (env wins key by key)
so existing deployments keep working; `loadConfig` warns and names the variable
replacing each key still coming from the file. `bun run migrate-config` writes
the `.env` and prints the `gh variable set` lines. The mapping table lives in
`CONFIG_JSON_TO_ENV` in `src/config.ts` — one source of truth for the warning
and the migration.

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
(one file per phase in `src/setup/steps/`). Note it creates a **plain typed
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
   shared `src/setup/skills-db.ts`, also used by `--ci`), the skills repo, and
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
   step also prints the setup-call gotchas inline (see `src/setup/guidance.ts`):
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
  real setup, then adds a final cleanup step (`src/setup/steps/cleanup.ts`)
  that offers to delete the GitHub repos the run created (`gh repo delete`,
  with a `gh auth refresh -h github.com -s delete_repo` hint if the scope is
  missing) and restores the rewired git remotes (`upstream` → `origin`).
  Pre-existing repos the user chose to reuse are never deleted; the Notion
  Skills DB is left for the user to trash in Notion.
- **Non-interactive:** `bun run setup --ci` (for agents/CI) — see
  `src/setup/non-interactive.ts`. Also honors `--repo`, `--db-name`,
  `--db-parent-page`. CI mode doesn't push the sync script repo or dispatch
  Actions, and takes credentials from the environment instead of the
  dedicated-token checkpoint.
- **Diagnostic log:** every run writes a JSONL log to
  `.notion-sync-setup/setup-<ts>.log.jsonl` (gitignored). It's crash-proof (one
  JSON object per line, flushed as it goes, with a `crash` record + stack on
  failure) and **redacts tokens**. Share/read this file to debug a stuck setup.
- Setup's spinners are a local shim (`src/setup/spinner.ts`), not
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

Notion reads are plain HTTPS against the Skills API and always use
`NOTION_API_TOKEN` — the same code path locally and in CI. There is **no
keychain fallback** any more: a local run without the token fails immediately
with a message saying so.

## Validation loop

What "done/verified" means here, in order:

1. `bunx tsc --noEmit` clean; `bun test` green. The suite is mostly **end to
   end**: `test/fake-skills-api.ts` is an in-memory Skills API served through the
   real client (genuine `.tar.gz` fixtures, pagination, 429s), and
   `src/target/memory.ts` is the other end, so `test/sync-e2e.test.ts` asserts on
   observable behaviour — resulting file tree, commit count, prune results,
   marketplace contents for all three clients, idempotency. Unit tests are kept
   only where the logic is intricate and general: untar, blob sha, slug
   assignment, retry-delay math, tree chunk boundaries, host resolution, config
   precedence, and `update`'s git behaviour (real temp repos).
2. `bun run dry-run` against the real workspace shows the expected plan.
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
4. **Idempotency:** immediately re-run `sync` → expect `Up to date`, no commit,
   and every skill listed under `unchanged` in the plan (the `version_id` fast
   path: no archive was downloaded at all).
   Also worth running once per change to `update`: a merge against a
   deliberately dirty tree (should refuse) and an `update --ci` run in CI.
5. **Prune:** delete a skill in Notion (or revoke the connection's access to
   it) → re-sync → its skill dir + any now-empty plugin's marketplace entry are
   removed; non-managed plugins untouched.

Only sync to the real `main` once the throwaway-branch run looks right.

## Where do I change X?

| Goal | Touch |
|---|---|
| Retarget repo / branch | `GITHUB_REPO` / `GITHUB_BRANCH` (`.env` locally, `SKILLS_GITHUB_*` repo variables in CI) |
| Rename a published plugin directory | Rename the plugin **in Notion** — directory names are slugified from the API's plugin names. The old directory is pruned on the next sync. `PLUGIN_SLUG` is only the fallback for an unnamed plugin |
| **Switch prod → dev** (internal) | Set `NOTION_ENV=dev` — every host comes from `src/notion/env.ts`, so this flips the Skills API host (`api.notion.com` → `api-dev.notion.com`), the app host in marker URLs, the injected updater's MCP URL, and the connector's name/key (`notion` → `notion-dev`) together. Also swap `NOTION_API_TOKEN` and the data-source/database/change-requests ids to dev values (those ids are only used for the marker + updater guidance, not for reading skills) |
| Surface a new skill field | Nothing here — it has to come from the Skills API. Add it to `Skill` in `src/notion/skills.ts` once the API returns it, then emit it in `src/sync/layout.ts` |
| Move a customer off an old-schema DB | Done **in-product** (Notion's "Turn into → Skills DB"). The Skills API only reports typed skills, so conversion is now a hard prerequisite rather than a nicety — see the gotcha below |
| Change skill file/archive handling | `src/notion/archive.ts` (download/extract/zip-expansion) + `src/notion/untar.ts` (tar reader) + `src/sync/plan.ts` (overlay prune) |
| Change the injected updater plugin | `src/sync/updater.ts` (and `INJECT_UPDATER` / `UPDATER_SLUG` to toggle/rename) |
| Add/change a supported client (manifest dir, marketplace path, entry shape) | `src/sync/clients.ts` (the `CLIENTS` registry — the ONE place per-client differences live) |
| Change file/marketplace layout | `src/sync/layout.ts` (paths, manifests, marker) + `src/sync/plan.ts` (merge/prune) + `src/sync/clients.ts` (per-client marketplace paths/shapes). **`SKILL.md` itself is not ours** — it arrives rendered from the API |
| Change GitHub write behavior | `src/target/github.ts` (Git Data API + the `SyncTarget` impl) |
| Publish somewhere other than GitHub | Implement `SyncTarget` (`src/target/target.ts`); `src/target/memory.ts` is the reference. Nothing in `src/sync/` needs to change |
| Add a Notion endpoint / auth method | `src/notion/` — `skills.ts` for resources, `auth.ts` for credentials, and export it from `index.ts` |
| Change what `update` does | `src/update.ts` + the auto-update step in `.github/workflows/sync.yml` |

## Architecture (three layers, one boundary each)

The organising idea: **talking to Notion's Skills API** (reusable by anyone) is
separate from **publishing a plugin marketplace** (our application), which is
separate from **where the files go** (the target).

```
src/
  cli.ts            commands: setup [--ci|--migrate-config] | sync [--dry-run] | update [--ci]
  config.ts         environment -> Config (config.json = deprecated fallback)
  wire.ts           assemble a NotionClient + GitHubTarget from a Config
  update.ts         merge tool changes from `upstream` (+ the CI auto-update path)
  notion/           <- REUSABLE: reading skills out of Notion. Single entry point.
    index.ts        NotionClient; the one import a consumer needs
    env.ts          host resolution (api / app / mcp) for prod | dev | stg | local
    auth.ts         Credential: static token today; the refresh seam for OAuth
    http.ts         transport: retries, typed NotionApiError, collectPaginated
    skills.ts       /v1/ai/plugins, /v1/ai/skills/:id (+ skills.files())
    archive.ts      signed URL -> tar.gz -> files; expands a lone attachment zip
    untar.ts        PURE: minimal tar reader (ustar + PAX + GNU long names)
    ntn.ts          low-level `ntn` invocation — used by SETUP ONLY, never by sync
  sync/             <- OUR APPLICATION: skills -> plugin marketplace
    engine.ts       orchestration; target-agnostic (incl. resolveSkills: the
                    version_id download-skip decision)
    plan.ts         PURE: desired file set, prune set, retained dirs, per-client
                    marketplace merges, injection
    layout.ts       PURE: skill/plugin paths, manifests, the sync marker
    clients.ts      PURE: supported clients + their manifest conventions
    updater.ts      PURE: builds the injected notion-skill-updater plugin
    slugify.ts      PURE: name -> unique slug (dedupes API kebab-case collisions)
  target/           <- WHERE IT LANDS
    target.ts       SyncTarget + content ids (git blob sha) + computeChanges
    github.ts       Git Data API client + GitHubTarget (one atomic commit/sync)
    memory.ts       in-memory target: the reference impl, and what tests run on
  setup/            guided setup: steps/, crash-proof logger, spinner shim,
                    migrate-config
api/sync.ts         Vercel handler (scaffold; see limitations)
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
   argument objects, an error type carrying Notion's own `code`, and
   `collectPaginated` mirroring `collectPaginatedAPI`. One deliberate divergence:
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

- **Setup-call gotchas live in `src/setup/guidance.ts`.** These are the
  human-in-the-loop snags from real rollout calls, kept as pure string builders
  so they're reusable and unit-tested (`test/setup-guidance.test.ts`): the two
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
  `src/sync/clients.ts`; the shared `plugin.json` bytes come from
  `buildPluginJson` in `src/sync/layout.ts`, so updating shared metadata updates
  every manifest.
- **Workflow-registration race on a fresh sync repo.** GitHub registers
  workflows when it processes a push to the repo's *configured* default branch.
  Pushing a differently-named branch first (e.g. a feature branch to an empty
  repo) makes that branch the default only *after* the push is processed — so
  `sync.yml` sits on the default branch but `actions/workflows` stays empty and
  `gh workflow run` 404s ("workflow not found on the default branch"). Fix: push
  `HEAD:<configured default branch>` (the setup does this now, and polls
  `repos/<r>/actions/workflows/sync.yml` for `state: active` before dispatching).
  Manual recovery: push any commit to the configured default branch name.
- **Setup failures abort with a handoff prompt** (`src/setup/handoff.ts`) —
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
- **There is no `Published` flag any more, and no per-skill opt-out.**
  `/v1/ai/plugins` returns *every* live skill in the bot's workspace that
  the token can read; the API has no row-level publish filter and we deliberately
  don't reimplement one (that would mean going back to querying the data source,
  which is the thing we removed). **Publishing control is now access control:**
  what syncs is exactly what the Notion connection has been granted. Scope the
  connection, not a checkbox.
- **The routes moved, and the response shape moved with them.** They were
  `/v1/skills/plugins` and `/v1/skills/directories/:id` until 2026-07; the old
  paths now answer `400 invalid_request_url` — a *routing* failure, so it looks
  nothing like the 403 you get from the feature gate. If every call suddenly
  400s, suspect a route rename before anything else. The list is now Notion's
  standard paginated envelope (`results` + `has_more`/`next_cursor` — the server
  ignores `page_size` but does emit a cursor, so `listPlugins` follows it), and
  a plugin's skills arrive under `skills`, not `skill_directories`.
- **Plugin grouping is back, and it comes from the API.** `/v1/ai/plugins`
  reports one plugin per skills grouping in the workspace — per-team plugins
  (e.g. "Finance", "EPD") *plus* Notion's own built-in `notion-workspace-skills`
  (362 skills in dev as of 2026-08). Every one of them is published as its own
  directory under `pluginsDir`, named by slugifying the plugin's name
  (`assignUniqueSlugs`, so a duplicate name gets `-2`). Two consequences worth
  holding onto: **(1)** the built-in Notion plugin is included, which means a
  first sync commits several hundred skills — that's deliberate, not a bug;
  **(2)** skill slugs are only unique *within* a plugin, so the same skill title
  in two plugins is fine and neither gets a suffix. `config.pluginSlug` is no
  longer the directory name — it survives only as the fallback base for a plugin
  the API returns with an empty name.
- **The endpoints are feature-gated (`public_api_skills_plugins`).** A workspace
  without the gate gets `403 restricted_resource` / "Endpoint unavailable." —
  the *same* response as a token missing read access, which is why
  the hints in `src/notion/skills.ts` name both causes. If the sync 403s on a
  workspace that used to work, check the gate before suspecting the token.
- **`ntn` is setup-only now.** `src/notion/ntn.ts` still exists because `setup`
  needs it (typed-DB creation via `tools/run`, file uploads). The sync path must
  never import it — that's what keeps CI free of the
  `curl https://ntn.dev | bash` step.
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
  `resolveSkills` hashes the marker it *would* write and compares against the
  base tree already in memory. It used to `getFileContent` each marker instead:
  369 serial GETs, ~59s of an otherwise no-op hourly run. Don't reintroduce a
  per-skill read — everything needed is in the `existing` map. Comparing the
  whole marker's sha (rather than just `version_id`) is deliberate: it also
  catches renames, config changes, and marker-format changes, so a new release
  self-heals the repo.
- **Idempotency is via git blob sha.** On top of that, the marker embeds the
  API's `version_id`, so `resolveSkills` compares the marker it *would* write
  against the repo's copy and skips the archive download entirely when they
  match. Comparing the whole rendered marker (not just `version_id`) means a
  config change — a different env or data-source id — still forces a rewrite.
  Building an archive is expensive server-side (render + fetch attachments +
  upload), so keep this fast path working.
- **Skill directories arrive as one `.tar.gz`, and the tar reader is ours.**
  `src/notion/untar.ts` is a hand-rolled reader because Node has no untar and the
  stream libraries pull a dep tree. It must handle **PAX extended headers** —
  `tar-stream` (what the server uses) emits one for *any* entry name that is
  non-ASCII or over 100 bytes, which is routine for Notion page titles and the
  API's 200-byte attachment names. Don't "simplify" it down to plain ustar.
- **A lone attachment `.zip` is still expanded in place.** The API archives an
  attached zip verbatim rather than unpacking it, so `extractSkillArchive`
  expands it when there's exactly one — otherwise a skill's `scripts/` and
  `assets/` folders would ship as an opaque zip. Anything else (no zip, several
  zips) is left as delivered. Zip the **contents at the root**, not a wrapping
  folder. The API-rendered `SKILL.md` and our marker always win over same-named
  zip entries. Bytes flow through as `FileContent = string | Uint8Array` (see
  `src/target/target.ts`) — `gitBlobSha` and `createBlob` handle binary via
  `toBytes`.
- **A managed skill dir owns its whole subtree — unless it's retained.**
  `plan.ts` prunes any existing file under a skill dir that isn't in this run's
  desired set, so a removed attachment cleans up. The exception is a *retained*
  skill (version_id matched, nothing downloaded): it contributes no desired
  files, so it's explicitly exempted from both prune passes. Get that wrong and
  the fast path deletes every skill it was supposed to leave alone — see the
  "retained (unchanged) skills" tests in `test/plan.test.ts`. Don't hand-add
  files under a managed `skills/<slug>/` dir; they'll be pruned.

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

- **Vercel deploy is scaffolded but unverified** (`api/sync.ts`, `vercel.json`).
  The old blocker is gone — the sync is plain HTTPS on both ends now, with no
  CLI dependency — so what's left is providing `NOTION_API_TOKEN` +
  `GITHUB_TOKEN` as Vercel env vars and confirming the Notion API host is
  reachable from the deployment (the dev workspace in particular may not be).
- **No dangling-marketplace-entry self-heal** (see gotchas).
- **No per-skill publish control** (see gotchas) — access to the Notion
  connection is the only lever. If customers need finer control, it has to come
  from the Skills API, not from this tool.
- **prod → dev migration** (internal Notion use) is a `NOTION_ENV` flip + token swap;
  prod is now the default for external users.
- **A cold sync resolves archives serially** — one `/v1/ai/skills/:id` + one
  download per skill, ~635ms each, so ~4 min for a 370-skill workspace. Notion
  documents ~3 requests/second per connection, so concurrency would cut that to
  roughly 2 min at best, not more; measured, deliberately not done yet. Warm
  runs don't touch this path at all.
