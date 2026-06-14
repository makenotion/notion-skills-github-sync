// Central configuration, loaded from the environment (Bun auto-loads .env).

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

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return v.trim();
}

export function loadConfig(): Config {
  return {
    notionEnv: process.env.NOTION_ENV?.trim() || "dev",
    dataSourceId: req("NOTION_DATA_SOURCE_ID"),
    databaseId: process.env.NOTION_DATABASE_ID?.trim() || "",
    changeRequestsDataSourceId:
      process.env.NOTION_CHANGE_REQUESTS_DATA_SOURCE_ID?.trim() || "",
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
