# notion-skills-github-sync

Publishes the skills in your Notion workspace to a GitHub repo, on a schedule, so
Claude Code / Cursor / Codex can install them as plugins.

Write a skill in Notion → it shows up in the repo → your team gets it in their editor.

## Quickstart

First time:

```bash
bun install
bun run setup          # asks everything, creates the Notion DB + repos, deploys
```

Day to day:

```bash
bun run dry-run        # show what would change; writes nothing
bun run sync           # do it for real
bun run update         # pull tool updates from the upstream repo
```

Working on this repo:

```bash
bun test
bunx tsc --noEmit
```

After setup a GitHub Action runs `sync` every hour, so normally you run nothing by hand.

## Setup

`bun run setup` walks you through it. It asks all its questions up front, then runs
unattended. It pauses once in the middle so you can create two tokens — one GitHub, one
Notion — and hands you pre-filled links for both.

You end up with three things:

- a **Notion Skills database** — where people write skills
- a **skills repo** — where plugins get published (always private)
- a **sync script repo** — a copy of this code, running the hourly Action

Other ways to run it:

```bash
bun run setup --ci         # no prompts, for agents/CI
bun run setup --test-run   # real run, then offers to delete what it created
bun run migrate-config     # convert an old config.json to .env
```

## What lands in the repo

```
.claude-plugin/marketplace.json      one per client, listing every plugin
.cursor-plugin/marketplace.json
.agents/plugins/marketplace.json

plugins/
  finance/                           one directory per plugin
    .claude-plugin/plugin.json       same content, three locations
    .cursor-plugin/plugin.json
    .codex-plugin/plugin.json
    skills/
      usd-currency-skill/
        SKILL.md                     comes from Notion, already rendered
        .notion-sync.json            "this one is managed by the sync"
        scripts/run.py               files attached to the Notion page
```

Each sync is **one commit**. If nothing changed, there's no commit at all.

## Things worth knowing

**There's no "publish" checkbox.** Every skill the Notion connection can read gets
published. If something shouldn't go out to your team, don't give the connection access
to it — access *is* the publish control.

**Notion decides the grouping.** Skills are grouped into plugins in Notion, and each
group becomes a directory here. Rename a plugin in Notion and the directory follows on
the next sync.

**`SKILL.md` isn't ours.** Notion renders it, frontmatter and all, and we write it down
verbatim. If a skill's text looks wrong, that's the Notion API, not this script.

**Don't hand-edit `plugins/`, and don't hand-edit the plugin lists.** Notion is the only
source of what's published, so each sync makes those match Notion exactly:

- any directory under `plugins/` that isn't in Notion gets deleted
- the `plugins` array in each `marketplace.json` is rewritten from scratch

So deleting a skill in Notion cleanly removes it, and a leftover entry pointing at a
directory that's gone cleans itself up. But a plugin you add to `plugins/` by hand
disappears on the next sync.

Everything else is yours and is never touched — including the `name`, `owner`, and
`description` at the top of each `marketplace.json`, which is your repo's identity, not
a plugin listing.

**Every marketplace gets a `notion-skill-updater` plugin** that we add ourselves. It
teaches your editor how to edit skills back in Notion, which closes the loop.

## Configuration

All of it is environment variables — `.env` locally, repo variables and secrets in CI.
Copy `.env.example` and fill it in; it documents every option.

The two you can't skip:

| | |
| --- | --- |
| `NOTION_API_TOKEN` | reads your skills |
| `GITHUB_REPO` | where to publish, as `owner/name` |

## How it works

Three parts. Each one can be swapped without touching the others.

```
 Notion ──►  src/notion/  ──►  src/sync/  ──►  src/target/  ──►  GitHub
              read it          decide what      write it
                               should exist
```

**`src/notion/`** talks to Notion's Skills API and hands back each skill as a folder of
files. It knows nothing about GitHub or plugins — you could lift this directory into
another project as-is.

**`src/sync/`** is the actual product: given what Notion has and what the repo has, work
out which files to write, which to delete, and what the marketplace manifests should
say. Pure functions, no network.

**`src/target/`** writes the files. `GitHubTarget` makes a commit; `MemoryTarget` just
records them in memory, which is how the test suite runs a whole sync without touching
the network.

## More docs

- **`.env.example`** — every setting, explained
- **`CLAUDE.md`** — deployment specifics, the Actions runbook, and the gotchas that bit
  us. Read it before changing anything.
- **`AGENTS.md`** — setting this up as an AI agent
