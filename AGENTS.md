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
  `curl -fsSL https://ntn.dev | bash`; it lands in `~/.local/bin`) and require a
  **`NOTION_API_TOKEN`** for the Notion *dev* workspace, plus a GitHub token
  (`GITHUB_TOKEN` / `GH_PUSH_TOKEN`, else `gh auth token`) with **push access** to
  the sync target repo.

### Live validation config (use these, not the stale ids in `CLAUDE.md`/`.env.example`)

- Sync target repo: **`makenotion/notion-skills-test`** (a dedicated test repo —
  safe to sync to its `main`). The production target is `makenotion/epd-skills`;
  do **not** run a real sync against its `main`.
- Notion *dev* ids: `NOTION_DATA_SOURCE_ID=f66a7cde-a6b9-4b5d-8bf1-4e3bfe15050d`
  (skills), `NOTION_CHANGE_REQUESTS_DATA_SOURCE_ID=e2459aa9-7cd9-434f-81d3-fd77d6cf2365`,
  `NOTION_DATABASE_ID=ddc803a3-e068-4d86-b64c-1db16ac924bd`.
- `bun run dry-run` is read-only; `bun run sync` writes one atomic commit and is
  idempotent (a re-run with no Notion changes prints "Up to date — no commit").

**Gotcha:** the tool can't bootstrap a *brand-new, commit-less* repo —
`getBranchHead` gets a `409 "Git Repository is empty"` (only `404` is handled).
If the target repo has zero commits, push one initial commit (e.g. a README) to
`main` first, then sync.

To exercise the conversion pipeline (Notion page → plugin marketplace files)
without Notion/GitHub, inject a mock `NotionClient` via `runSync`'s
`opts.notionClient`, or drive the pure functions in `src/plan.ts` /
`src/convert.ts` directly.
