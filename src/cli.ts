#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { runMigrateConfig } from "./migrate-config.ts";
import { runSync } from "./sync/engine.ts";
import { runSetup } from "../setup/index.ts";
import { runUpdate } from "./update.ts";
import { buildSync } from "./wire.ts";

const HELP = `notion-skills-github-sync — publish a Notion workspace's skills as a plugin marketplace

Usage:
  notion-skills-sync setup            Interactive guided setup (start here)
  notion-skills-sync setup --ci       Non-interactive mode (for agents/CI)
  notion-skills-sync sync             Sync the workspace's skills to the target repo
  notion-skills-sync sync --dry-run   Show what would change without pushing
  notion-skills-sync update           Merge tool updates from the 'upstream' remote
  notion-skills-sync migrate-config   Copy a legacy config.json into .env + repo variables
  notion-skills-sync help             Show this help

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
  --db-parent-page <id>   Parent page ID or URL for the database (required in CI;
                          optional in interactive setup, which prompts otherwise)

Update flags:
  --branch <name>         Upstream branch to merge (default: main)

Migrate-config flags:
  --repo <owner/name>     Sync repo whose Actions variables to set
                          (default: detected from the 'origin' remote)
  --env-only              Write .env only; skip the repo variables

Configuration comes from environment variables (.env locally, repo variables and
secrets in CI). See .env.example.`;

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "setup":
    case "wizard": {
      // "wizard" is the legacy name for "setup"; kept as an undocumented alias.
      if (rest.includes("--migrate-config")) {
        // Without this guard the flag would fall through and silently launch
        // the full interactive wizard instead.
        throw new Error(
          "--migrate-config moved: run `notion-skills-sync migrate-config` " +
            "(bun run migrate-config) to copy config.json into .env and repo variables.",
        );
      }
      const ci = rest.includes("--ci") || rest.includes("--non-interactive");
      const testRun = rest.includes("--test-run");
      await runSetup({
        ci,
        testRun,
        notionEnv: flagValue(rest, "--env"),
        githubRepo: flagValue(rest, "--repo"),
        dbName: flagValue(rest, "--db-name"),
        parentPageId: flagValue(rest, "--db-parent-page"),
      });
      break;
    }
    case "sync": {
      const dryRun = rest.includes("--dry-run") || rest.includes("-n");
      const config = loadConfig();
      await runSync(buildSync(config, { dryRun }));
      break;
    }
    case "update": {
      runUpdate({ branch: flagValue(rest, "--branch") });
      break;
    }
    case "migrate-config": {
      runMigrateConfig({
        repo: flagValue(rest, "--repo"),
        envOnly: rest.includes("--env-only"),
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
