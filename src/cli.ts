#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { runSync } from "./sync.ts";
import { runSetup } from "./setup.ts";
import { runWizard } from "./wizard/index.ts";

const HELP = `notion-skills-github-sync — sync a Notion skills DB into a GitHub plugin marketplace

Usage:
  notion-skills-sync wizard           Interactive setup wizard (start here)
  notion-skills-sync setup            Add the "Published" checkbox to the DB and check existing rows
  notion-skills-sync sync             Sync published skills to the GitHub branch
  notion-skills-sync sync --dry-run   Show what would change without pushing
  notion-skills-sync help             Show this help

Config comes from config.json (non-secret settings) and environment variables (secrets).`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "wizard": {
      const notionEnv = rest.includes("--env")
        ? rest[rest.indexOf("--env") + 1]
        : undefined;
      await runWizard({ notionEnv });
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
