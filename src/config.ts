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
// Accepts URLs where appropriate and normalizes them to IDs internally.
interface FileConfig {
  notionEnv?: string;
  skillsDataSourceId?: string;
  skillsDatabaseId?: string;
  skillsDatabaseUrl?: string; // alternative: accepts Notion URL, extracts database ID
  changeRequestsDataSourceId?: string;
  githubRepo?: string; // accepts both "owner/repo" and "https://github.com/owner/repo"
  githubBranch?: string;
  pluginsDir?: string;
  authorName?: string;
  authorEmail?: string;
  injectUpdater?: boolean;
  updaterSlug?: string;
}

// Extract database ID from a Notion URL (e.g., https://notion.so/workspace/<id>?v=...)
function extractNotionDatabaseId(urlOrId: string): string {
  // If it looks like a URL, extract the ID from the path
  if (urlOrId.includes("notion.so") || urlOrId.includes("notion.com")) {
    // Match patterns like: notion.so/workspace/<id> or notion.so/<id>
    const match = urlOrId.match(/notion\.[a-z]+\/(?:[^/]+\/)?([a-f0-9]{32})/i);
    if (match?.[1]) {
      return match[1];
    }
    // Also try to match UUIDs with dashes
    const uuidMatch = urlOrId.match(
      /notion\.[a-z]+\/(?:[^/]+\/)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    );
    if (uuidMatch?.[1]) {
      return uuidMatch[1].replace(/-/g, "");
    }
  }
  // Otherwise assume it's already an ID
  return urlOrId;
}

// Normalize GitHub repo: accept "owner/repo" or "https://github.com/owner/repo"
function normalizeGithubRepo(repoOrUrl: string): string {
  // If it looks like a URL, extract owner/repo
  if (repoOrUrl.includes("github.com")) {
    const match = repoOrUrl.match(/github\.com\/([^/]+\/[^/]+)/);
    if (match?.[1]) {
      // Remove .git suffix if present
      return match[1].replace(/\.git$/, "");
    }
  }
  // Otherwise assume it's already in owner/repo format
  return repoOrUrl;
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

  const githubRepoRaw = fileConfig.githubRepo?.trim();
  if (!githubRepoRaw) {
    throw new Error(
      "Missing githubRepo in config.json. Set it to 'owner/name' format or a GitHub URL.",
    );
  }
  const githubRepo = normalizeGithubRepo(githubRepoRaw);

  // Accept either skillsDatabaseId or skillsDatabaseUrl (URL is normalized to ID)
  const rawDatabaseId =
    fileConfig.skillsDatabaseId?.trim() || fileConfig.skillsDatabaseUrl?.trim();
  const skillsDatabaseId = rawDatabaseId
    ? extractNotionDatabaseId(rawDatabaseId)
    : "";

  return {
    notionEnv: fileConfig.notionEnv?.trim() || "prod",
    skillsDataSourceId,
    skillsDatabaseId,
    changeRequestsDataSourceId:
      fileConfig.changeRequestsDataSourceId?.trim() || "",
    githubRepo,
    githubBranch: fileConfig.githubBranch?.trim() || "main",
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
