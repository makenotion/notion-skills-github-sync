// Assembling the two edges of a sync from configuration.
//
// This is the only place that knows the default deployment reads Notion over
// HTTPS and writes to GitHub. Swapping either side — a different target, a
// pre-authenticated client — means calling `runSync` with different arguments,
// not editing the engine.

import type { Config } from "./config.ts";
import { NotionClient } from "./notion/index.ts";
import { GitHubTarget } from "./target/github.ts";
import type { SyncOptions } from "./sync/engine.ts";

export function buildSync(config: Config, opts: { dryRun?: boolean } = {}): SyncOptions {
  if (!config.notion.token) {
    throw new Error(
      "Missing NOTION_API_TOKEN. The sync reads the Notion Skills API directly over HTTPS; " +
        "set NOTION_API_TOKEN in the environment (or .env for local runs).",
    );
  }

  const source = new NotionClient({
    auth: config.notion.token,
    env: config.notion.env,
    baseUrl: config.notion.baseUrl,
    logger: (_level, message) => console.warn(`  ⏳ ${message}`),
  });

  const target = new GitHubTarget({
    repo: config.github.repo,
    branch: config.github.branch,
    token: config.github.token,
    authorName: config.github.authorName,
    authorEmail: config.github.authorEmail,
  });

  return { source, target, settings: config.sync, dryRun: opts.dryRun };
}
