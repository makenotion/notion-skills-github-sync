// Central configuration, loaded from config.json (for non-secret settings) and
// environment variables (for auth secrets only). Bun auto-loads .env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  notionEnv: string;
  notionToken: string | undefined;
  skillsDataSourceId: string;
  skillsDatabaseId: string;
  changeRequestsDataSourceId: string; // optional; enables "propose a change" in the updater
  githubRepo: string; // "owner/name"
  githubBranch: string;
  githubToken: string | undefined;
  pluginsDir: string;
  /** Directory under pluginsDir that all synced skills are published into. */
  pluginSlug: string;
  authorName: string;
  authorEmail: string;
  injectUpdater: boolean;
  updaterSlug: string;
}

// Configuration from config.json (all non-secret settings).
interface FileConfig {
  notionEnv?: string;
  skillsDataSourceId?: string;
  skillsDatabaseId?: string;
  changeRequestsDataSourceId?: string;
  githubRepo?: string;
  githubBranch?: string;
  pluginsDir?: string;
  pluginSlug?: string;
  authorName?: string;
  authorEmail?: string;
  injectUpdater?: boolean;
  updaterSlug?: string;
}

// Load config.json from the workspace root.
function loadFileConfig(): FileConfig {
  const configPath = join(process.cwd(), "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      "Missing config.json. See AGENTS.md for setup instructions.\n" +
        "Copy config.json.example and fill in your settings.",
    );
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as FileConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadConfig(): Config {
  const fileConfig = loadFileConfig();

  // Note: skillsDataSourceId is no longer needed to *read* skills — the Notion
  // skills API scopes to the token's workspace. It's kept for the marker's
  // back-reference and the injected updater's write-back guidance.
  const skillsDataSourceId = fileConfig.skillsDataSourceId?.trim() ?? "";

  const githubRepo = fileConfig.githubRepo?.trim();
  if (!githubRepo) {
    throw new Error(
      "Missing githubRepo in config.json. Set it to 'owner/name' format.",
    );
  }

  return {
    notionEnv: fileConfig.notionEnv?.trim() || "prod",
    notionToken: process.env.NOTION_API_TOKEN?.trim() || undefined,
    skillsDataSourceId,
    skillsDatabaseId: fileConfig.skillsDatabaseId?.trim() || "",
    changeRequestsDataSourceId:
      fileConfig.changeRequestsDataSourceId?.trim() || "",
    githubRepo,
    githubBranch: fileConfig.githubBranch?.trim() || "main",
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
    pluginsDir: fileConfig.pluginsDir?.trim() || "plugins",
    pluginSlug: fileConfig.pluginSlug?.trim() || "skills",
    authorName: fileConfig.authorName?.trim() || "notion-skills-sync",
    authorEmail:
      fileConfig.authorEmail?.trim() ||
      "notion-skills-sync@users.noreply.github.com",
    injectUpdater: fileConfig.injectUpdater !== false,
    updaterSlug: fileConfig.updaterSlug?.trim() || "notion-skill-updater",
  };
}
