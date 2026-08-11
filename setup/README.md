# setup/ — the guided setup

`bun run setup` is the one-time, interactive rollout: it creates the Notion
Skills DB and the two GitHub repos, pauses once while you create two dedicated
minimal-scope tokens, then deploys the workflow and verifies a real sync end to
end. `bun run setup --ci` is the same flow without prompts, for agents and CI.

**This is a separate package from the sync core in `src/`, deliberately.** The
wizard is a human-in-the-loop tool that shells out to the `ntn` and `gh` CLIs and
lives on browser round-trips; the sync it configures is plain HTTPS against
Notion and GitHub, with no CLI dependency. So the sync core — `src/notion/`,
`src/sync/`, `src/target/` — may never import from here, which is what keeps the
`ntn` install out of CI. `src/cli.ts` is the one exception, and only to dispatch
the `setup` command. Otherwise the dependency runs one way: `setup/` reads a few
pure helpers out of `src/` (`config.ts` for the CI variable naming,
`notion/archive.ts` to zip a sample skill's files, `sync/slugify.ts`).

Layout: `index.ts` is the six-phase interactive flow and `steps/` holds one file
per phase; `non-interactive.ts` is the `--ci` runner. The rest is shared
plumbing — `exec.ts` (logged subprocesses), `ntn-cli.ts`, `skills-db.ts`,
`verify-sync.ts` (the dry-run → sync → re-run proof both flows end with),
`env-file.ts`, `logger.ts`, `spinner.ts`, `guidance.ts`, `handoff.ts`.

Every run writes a redacted, crash-proof JSONL log to
`.notion-sync-setup/setup-<timestamp>.log.jsonl` (gitignored). That file is the
first thing to read — or share — when a run gets stuck.
