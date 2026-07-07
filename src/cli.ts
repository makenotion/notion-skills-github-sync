#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { runSync } from "./sync.ts";
import { runSetup } from "./setup.ts";
import { runWizard } from "./wizard/index.ts";

const HELP = `notion-skills-github-sync — sync a Notion skills DB into a GitHub plugin marketplace

Usage:
  notion-skills-sync wizard           Interactive setup wizard (start here)
  notion-skills-sync wizard --ci      Non-interactive mode (for agents/CI)
  notion-skills-sync setup            Add the "Published" checkbox to the DB and check existing rows
  notion-skills-sync sync             Sync published skills to the GitHub branch
  notion-skills-sync sync --dry-run   Show what would change without pushing
  notion-skills-sync help             Show this help

Wizard flags:
  --ci                    Run non-interactively (no prompts, uses env tokens)
  --env <env>             Notion environment (dev|stg|prod, default: prod)
  --repo <owner/name>     Target GitHub repo (auto-detected from git remote if omitted)
  --db-name <name>        Name for the Notion database (default: "Wizard CI Test Skills")
  --db-parent-page <id>   Parent page ID for the database (required for some tokens)

Config comes from config.json (non-secret settings) and environment variables (secrets).`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "wizard": {
      const ci = rest.includes("--ci") || rest.includes("--non-interactive");
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
      await runWizard({ ci, notionEnv, githubRepo, dbName, parentPageId });
      break;
    }
    case "setup": {
      await runSetup(loadConfig());
      break;
    }
    case "sync": {
      const dryRun = rest.includes("--dry-run") || rest.includes("-n");
      const res = await runSync(loadConfig(), { dryRun });
      if (!dryRun && !res.committed) process.exitCode = 0;
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
