# AGENTS.md

See [`README.md`](./README.md) for the tool overview and [`CLAUDE.md`](./CLAUDE.md)
for deployment specifics, the GitHub Actions runbook, secret rotation, and the
full validation loop. Standard commands live in `package.json` `scripts`.

## Cursor Cloud specific instructions

This is a Bun + TypeScript CLI (no GUI, no long-running service). The runtime is
**Bun** (the update script runs `bun install --frozen-lockfile`); `bun` is on
`PATH` via `/usr/local/bin/bun`.

What runs **without any secrets** (use these for verification):

- `bun test` — full pure-core suite (convert / plan / diff / slugify / updater).
- `bun run typecheck` — `tsc --noEmit`.

What does **NOT** run out of the box (needs setup not covered by the update script):

- `bun run sync` / `bun run dry-run` shell out to the **`ntn` CLI** (install with
  `curl -fsSL https://ntn.dev | bash`) and require a **`NOTION_API_TOKEN`** for the
  Notion *dev* workspace. They also need a GitHub token (`GITHUB_TOKEN`, else it
  falls back to `gh auth token`) with **push access to the target repo**
  (`makenotion/epd-skills`).
- `bun run sync` (non-dry) writes a real commit to that external production repo.
  Do **not** run a real sync against `main`; if testing live, point
  `GITHUB_BRANCH` at a throwaway branch first (see `CLAUDE.md` validation loop).

To exercise the conversion pipeline (Notion page → plugin marketplace files)
without Notion/GitHub, inject a mock `NotionClient` via `runSync`'s
`opts.notionClient`, or drive the pure functions in `src/plan.ts` /
`src/convert.ts` directly.
