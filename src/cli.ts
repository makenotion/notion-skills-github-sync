#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { runSync } from "./sync.ts";
import { runWizard } from "./wizard/index.ts";
import { runMigrate } from "./migrate.ts";

const HELP = `notion-skills-github-sync — sync a Notion skills DB into a GitHub plugin marketplace

Usage:
  notion-skills-sync setup            Interactive guided setup (start here)
  notion-skills-sync setup --ci       Non-interactive mode (for agents/CI)
  notion-skills-sync sync             Sync published skills to the GitHub branch
  notion-skills-sync sync --dry-run   Show what would change without pushing
  notion-skills-sync migrate          Move an old-schema DB onto a typed skills DB
  notion-skills-sync migrate --dry-run  Create + populate the new DB without finalizing
  notion-skills-sync help             Show this help

Migrate flags:
  --dry-run               Create the typed DB and copy data, but don't repoint
                          config.json or archive the old DB
  --keep-old              Don't archive the old DB after repointing config.json
  --yes                   Proceed with repoint/archive without an interactive prompt

Interactive setup asks everything up front, creates the Notion Skills DB and
GitHub repos, pauses once while you create two dedicated access tokens (a
fine-grained GitHub PAT + a Notion integration token), then deploys and
verifies unattended.

Setup flags:
  --ci                    Run non-interactively (no prompts, uses env tokens)
  --test-run              Real setup end to end, then help delete the created
                          GitHub repos at the end (interactive mode only)
  --env <env>             Notion environment (dev|stg|prod, default: prod)
  --repo <owner/name>     Skills repo, CI mode only (auto-detected from git remote if omitted)
  --db-name <name>        Name for the Notion Skills DB (default: "Skills")
  --db-parent-page <id>   Parent page ID for the database (CI mode, required)

Config comes from config.json (non-secret settings) and environment variables (secrets).`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "setup":
    case "wizard": {
      // "wizard" is the legacy name for "setup"; kept as an undocumented alias.
      const ci = rest.includes("--ci") || rest.includes("--non-interactive");
      const testRun = rest.includes("--test-run");
      const notionEnv = rest.includes("--env")
        ? rest[rest.indexOf("--env") + 1]
        : undefined;
      const githubRepo = rest.includes("--repo")
        ? rest[rest.indexOf("--repo") + 1]
        : undefined;
      const dbName = rest.includes("--db-name")
        ? rest[rest.indexOf("--db-name") + 1]
        : undefined;
      const parentPageId = rest.includes("--db-parent-page")
        ? rest[rest.indexOf("--db-parent-page") + 1]
        : undefined;
      await runWizard({ ci, testRun, notionEnv, githubRepo, dbName, parentPageId });
      break;
    }
    case "sync": {
      const dryRun = rest.includes("--dry-run") || rest.includes("-n");
      const res = await runSync(loadConfig(), { dryRun });
      if (!dryRun && !res.committed) process.exitCode = 0;
      break;
    }
    case "migrate": {
      await runMigrate({
        dryRun: rest.includes("--dry-run") || rest.includes("-n"),
        keepOld: rest.includes("--keep-old"),
        yes: rest.includes("--yes") || rest.includes("-y"),
      });
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
