# CLAUDE.md — agent & maintainer notes

Operational + deployment context for this repo. The [README](./README.md) is the
generic, shareable description of the tool; **this file is the specifics of how
it's actually deployed and the hard-won gotchas.** Read both.

> One-line mental model: read skill pages from a Notion database → render each to
> a Claude Code plugin → commit the whole set into a GitHub repo that's a plugin
> marketplace, on a schedule.

## Configuration overview

Configuration lives in two places:
- **`config.json`** (committed to the repo) — all non-secret settings
- **GitHub repo secrets** — authentication tokens (`NOTION_API_TOKEN`, `GH_PUSH_TOKEN`)

To set up: copy `config.json.example` to `config.json`, fill in your settings,
and commit it. Secrets go in GitHub repo secrets (or `.env` for local dev).
See [`AGENTS.md`](./AGENTS.md) for AI agent setup.

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
3. **Safe end-to-end:** point `GITHUB_BRANCH` at a throwaway branch first (e.g.
   `notion-sync`), `bun run sync`, then verify with the official validator:
   ```bash
   git clone <target-repo> /tmp/check && cd /tmp/check
   claude plugin validate .claude-plugin/marketplace.json --strict
   claude plugin validate plugins/<slug> --strict
   ```
4. **Idempotency:** immediately re-run `sync` → expect `Up to date`, no commit.
5. **Prune:** uncheck a skill's `Published` in Notion → re-sync → its plugin +
   marketplace entry are removed; non-managed plugins untouched.

Only sync to the real `main` once the throwaway-branch run looks right.

## Where do I change X?

| Goal | Touch |
|---|---|
| Retarget repo / branch / DB | `config.json` (commit the change) |
| **Switch dev → prod** | Set `notionEnv: "prod"` in config.json — flips *both* the `ntn` env and the injected updater's MCP URL (`mcp-dev.notion.com` → `mcp.notion.com`) **and** the connector's name/key (`notion-dev` → `notion`, so dev/prod connectors are distinguishable in the client). Also swap `NOTION_API_TOKEN` secret and data-source/database/change-requests ids in config.json to prod values, and re-run `setup`. |
| Map a new Notion property | `src/notion/ntn-adapter.ts` (read it) + `src/convert.ts` (emit it) |
| Change the injected updater plugin | `src/updater.ts` (and `INJECT_SKILL_UPDATER` / `UPDATER_SLUG` to toggle/rename) |
| Change file/marketplace layout | `src/convert.ts` (paths, frontmatter) + `src/plan.ts` (merge/prune) |
| Change GitHub write behavior | `src/github.ts` (Git Data API) + `src/plan.ts` |

## Architecture (pure core, thin edges)

```
src/
  cli.ts            commands: setup | sync [--dry-run]
  config.ts         config.json -> Config
  setup.ts          adds the Published property + checks rows
  sync.ts           orchestration: Notion -> plan -> GitHub commit
  plan.ts           PURE: desired file set, prune set, marketplace merge, injection
  convert.ts        PURE: page -> SKILL.md / plugin.json / marker
  diff.ts           PURE: git-blob-sha diffing / idempotency
  slugify.ts        PURE: name -> unique slug
  updater.ts        PURE: builds the injected notion-skill-updater plugin
  github.ts         GitHub Git Data API client (one atomic commit per sync)
  notion/
    types.ts        NotionClient interface  <-- swap-in seam for a REST adapter
    ntn.ts          low-level `ntn` invocation
    ntn-adapter.ts  NotionClient backed by the `ntn` CLI
api/sync.ts         Vercel handler (scaffold; see limitations)
```

The `PURE` modules hold all the logic and are unit-tested; `ntn`/GitHub are thin
and swappable.

## Gotchas (these bit us — don't relearn them)

- **Marketplace manifest path:** `.claude-plugin/marketplace.json`, **not** a
  root `marketplace.json`. (We shipped a stray root file once.)
- **Marker = "managed by this tool".** Only plugins with a
  `.notion-sync.json` next to their `SKILL.md` are eligible for **pruning**.
  Hand-authored plugins and the injected updater have **no marker** and are never
  pruned. The updater must **stay** marker-less, or it'll be pruned every sync.
- **Dangling marketplace entries are NOT auto-healed.** If a plugin dir is
  deleted (e.g. by hand) but its `marketplace.json` entry remains, the sync won't
  fix it — it only manages marker-bearing entries + its own injected/Notion
  entries. We hit this with `hello-world` and fixed `marketplace.json` manually.
  (Candidate future improvement: drop entries whose `source` dir doesn't exist.)
- **Empty Notion `Description`** → the description is auto-derived from the first
  body line and a `⚠` is printed. Fill in `Description` in Notion for good agent
  routing.
- **`ntn` is the Notion layer.** It's the dependency that makes CI non-trivial
  (installed via `curl https://ntn.dev | bash`). It reads `NOTION_API_TOKEN` /
  `NOTION_ENV` from the environment.
- **Idempotency is via git blob sha**, and the marker's `contentHash` is stable
  across runs (excludes volatile fields), so unchanged skills produce no commit.

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
- **dev → prod migration** is a config flip + token/id swap + `setup` re-run; not
  yet exercised end-to-end against prod.
