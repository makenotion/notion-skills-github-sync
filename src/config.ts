// Central configuration, loaded from config.json (for non-secret settings) and
// environment variables (for auth secrets only). Bun auto-loads .env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  notionEnv: string;
  skillsDataSourceId: string;
  skillsDatabaseId: string;
  changeRequestsDataSourceId: string; // optional; enables "propose a change" in the updater
  githubRepo: string; // "owner/name"
  githubBranch: string;
  githubToken: string | undefined;
  pluginsDir: string;
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

  const skillsDataSourceId = fileConfig.skillsDataSourceId?.trim();
  if (!skillsDataSourceId) {
    throw new Error(
      "Missing skillsDataSourceId in config.json. See AGENTS.md for setup instructions.",
    );
  }

  const githubRepo = fileConfig.githubRepo?.trim();
  if (!githubRepo) {
    throw new Error(
      "Missing githubRepo in config.json. Set it to 'owner/name' format.",
    );
  }

  return {
    notionEnv: fileConfig.notionEnv?.trim() || "dev",
    skillsDataSourceId,
    skillsDatabaseId: fileConfig.skillsDatabaseId?.trim() || "",
    changeRequestsDataSourceId: fileConfig.changeRequestsDataSourceId?.trim() || "",
    githubRepo,
    githubBranch: fileConfig.githubBranch?.trim() || "notion-sync",
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
    pluginsDir: fileConfig.pluginsDir?.trim() || "plugins",
    authorName: fileConfig.authorName?.trim() || "notion-skills-sync",
    authorEmail:
      fileConfig.authorEmail?.trim() ||
      "notion-skills-sync@users.noreply.github.com",
    injectUpdater: fileConfig.injectUpdater !== false,
    updaterSlug: fileConfig.updaterSlug?.trim() || "notion-skill-updater",
  };
}
