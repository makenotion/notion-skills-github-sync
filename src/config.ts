// Central configuration, loaded from config.json (for Notion IDs) and
// environment variables (for auth and other settings). Bun auto-loads .env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  notionEnv: string;
  dataSourceId: string;
  databaseId: string;
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

// Configuration from config.json (Notion database IDs).
interface FileConfig {
  dataSourceId?: string;
  databaseId?: string;
  changeRequestsDataSourceId?: string;
}

// Try to load config.json from the workspace root.
function loadFileConfig(): FileConfig | null {
  const configPath = join(process.cwd(), "config.json");
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as FileConfig;
  } catch (err) {
    console.warn(
      `⚠ Failed to parse config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return v.trim();
}

export function loadConfig(): Config {
  const fileConfig = loadFileConfig();

  // Notion database IDs: prefer config.json, fall back to env vars.
  const dataSourceId =
    fileConfig?.dataSourceId?.trim() ||
    process.env.NOTION_DATA_SOURCE_ID?.trim();
  const databaseId =
    fileConfig?.databaseId?.trim() || process.env.NOTION_DATABASE_ID?.trim();
  const changeRequestsDataSourceId =
    fileConfig?.changeRequestsDataSourceId?.trim() ||
    process.env.NOTION_CHANGE_REQUESTS_DATA_SOURCE_ID?.trim() ||
    "";

  if (!dataSourceId) {
    throw new Error(
      "Missing dataSourceId. Set it in config.json or NOTION_DATA_SOURCE_ID env var.\n" +
        "See AGENTS.md for setup instructions.",
    );
  }

  return {
    notionEnv: process.env.NOTION_ENV?.trim() || "dev",
    dataSourceId,
    databaseId: databaseId || "",
    changeRequestsDataSourceId,
    githubRepo: req("GITHUB_REPO"),
    githubBranch: process.env.GITHUB_BRANCH?.trim() || "notion-sync",
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
    pluginsDir: process.env.PLUGINS_DIR?.trim() || "plugins",
    authorName: process.env.GIT_AUTHOR_NAME?.trim() || "notion-skills-sync",
    authorEmail:
      process.env.GIT_AUTHOR_EMAIL?.trim() ||
      "notion-skills-sync@users.noreply.github.com",
    injectUpdater: process.env.INJECT_SKILL_UPDATER?.trim() !== "false",
    updaterSlug: process.env.UPDATER_SLUG?.trim() || "notion-skill-updater",
  };
}
