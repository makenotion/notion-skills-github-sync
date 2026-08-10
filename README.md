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
    plugin.json                      Agent Plugins manifest from Notion
    .claude-plugin/plugin.json       Claude manifest derived from plugin.json
    .notion-sync.json                "managed by the sync", plus the version
    mcp.json                         any other plugin files pass through
    skills/
      usd-currency-skill/
        SKILL.md                     comes from Notion, already rendered
        scripts/run.py               files attached to the Notion page
```

The entire plugin arrives from Notion. The sync strips its transport wrapper, expands a
skill's single attached zip when present, derives the Claude compatibility manifest and
`.notion-sync.json`, and otherwise copies the plugin through untouched. Cursor and
ChatGPT/Codex read the standard root `plugin.json` directly.

Each sync is **one commit**. If nothing changed, there's no commit at all.

## Things worth knowing

**There's no "publish" checkbox.** Every skill the Notion connection can read gets
published. If something shouldn't go out to your team, don't give the connection access
to it — access *is* the publish control.

**Notion decides the grouping.** Skills are grouped into plugins in Notion, and each
group becomes a directory here. Rename a plugin in Notion and the directory follows on
the next sync.

**The plugin is the unit of everything.** Notion's API has no concept of an individual
skill you can ask about — a plugin's skills are whatever's inside the archive it hands
back. So the sync tracks a version per plugin: if anything inside one changes, that
plugin is re-fetched whole. It still only commits the files that actually differ, so a
one-word edit is a one-file commit.

**`SKILL.md` isn't ours.** Notion renders it, frontmatter and all, and we write it down
verbatim. If a skill's text looks wrong, that's the Notion API, not this script.

**The first sync is slow.** It downloads every plugin one at a time, and each one is
built on Notion's side as you ask for it — on a workspace with hundreds of plugins that
takes tens of minutes. Every run after that is fast: if nothing changed, it downloads
nothing at all.

**Don't hand-edit `plugins/`, and don't hand-edit the plugin lists.** Notion is the only
source of what's published:

- any directory under `plugins/` that isn't in Notion gets deleted
- the `plugins` array in each `marketplace.json` is rewritten from scratch

So deleting a skill in Notion cleanly removes it, and a leftover entry pointing at a
directory that's gone cleans itself up. But a plugin you add to `plugins/` by hand
disappears on the next sync.

An unchanged plugin is cached solely by its Notion `version_id`; the sync does not
inspect its internal repo files. A hand edit inside one may linger until that plugin
next changes in Notion, at which point its directory is replaced from the new archive.

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

**`src/notion/`** talks to Notion's Plugins API: it lists plugins and downloads each one
as a single archive, handing back the files that plugin's directory should contain. It
knows nothing about GitHub — you could lift this directory into another project as-is.

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
