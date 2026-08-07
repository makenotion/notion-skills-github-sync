// Central configuration. Non-secret settings come from config.json (local dev)
// and/or environment variables (deployment). Auth secrets come only from
// environment variables. Bun auto-loads .env.
//
// Precedence: environment variables override config.json. This lets the GitHub
// Action run with NO committed config.json — the CLI populates each value as a
// repo-level Actions *variable* (see src/wizard/steps/deploy.ts) which the
// workflow injects as the env vars below. Locally, config.json is the source of
// truth and these env vars are simply unset.

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

// The env var that can supply each non-secret config field. This is the ONE
// place these names live: config loading reads them, `deploy` sets them as repo
// variables, and .github/workflows/sync.yml maps `vars.*` onto them. Names are
// namespaced (and deliberately NOT prefixed `GITHUB_`, which GitHub reserves
// for its own variables/secrets and won't let you create).
export const CONFIG_ENV_VARS: Record<keyof FileConfig, string> = {
  notionEnv: "NOTION_SKILLS_NOTION_ENV",
  skillsDataSourceId: "NOTION_SKILLS_DATA_SOURCE_ID",
  skillsDatabaseId: "NOTION_SKILLS_DATABASE_ID",
  changeRequestsDataSourceId: "NOTION_SKILLS_CHANGE_REQUESTS_DATA_SOURCE_ID",
  githubRepo: "NOTION_SKILLS_GITHUB_REPO",
  githubBranch: "NOTION_SKILLS_GITHUB_BRANCH",
  pluginsDir: "NOTION_SKILLS_PLUGINS_DIR",
  authorName: "NOTION_SKILLS_AUTHOR_NAME",
  authorEmail: "NOTION_SKILLS_AUTHOR_EMAIL",
  injectUpdater: "NOTION_SKILLS_INJECT_UPDATER",
  updaterSlug: "NOTION_SKILLS_UPDATER_SLUG",
};

// Load config.json from the workspace root. Missing is fine — the config can be
// fully supplied by environment variables (the deployment path).
function loadFileConfig(): FileConfig {
  const configPath = join(process.cwd(), "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as FileConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Read a string field, preferring the environment variable over config.json.
function pick(
  fileConfig: FileConfig,
  env: NodeJS.ProcessEnv,
  key: Exclude<keyof FileConfig, "injectUpdater">,
): string | undefined {
  const fromEnv = env[CONFIG_ENV_VARS[key]]?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = fileConfig[key];
  return typeof fromFile === "string" ? fromFile.trim() : undefined;
}

// Resolve the effective config from a file config + an environment. Pure so it
// can be unit-tested; loadConfig() wires it to disk + process.env.
export function resolveConfig(
  fileConfig: FileConfig,
  env: NodeJS.ProcessEnv,
): Config {
  const skillsDataSourceId = pick(fileConfig, env, "skillsDataSourceId");
  if (!skillsDataSourceId) {
    throw new Error(
      "Missing skillsDataSourceId. Set it in config.json or the " +
        `${CONFIG_ENV_VARS.skillsDataSourceId} environment variable. ` +
        "See AGENTS.md for setup instructions.",
    );
  }

  const githubRepo = pick(fileConfig, env, "githubRepo");
  if (!githubRepo) {
    throw new Error(
      "Missing githubRepo. Set it (in 'owner/name' format) in config.json or " +
        `the ${CONFIG_ENV_VARS.githubRepo} environment variable.`,
    );
  }

  // injectUpdater defaults to true; only an explicit "false" (env or file) opts out.
  const injectUpdaterEnv = env[CONFIG_ENV_VARS.injectUpdater]?.trim();
  const injectUpdater =
    injectUpdaterEnv !== undefined && injectUpdaterEnv !== ""
      ? injectUpdaterEnv.toLowerCase() !== "false"
      : fileConfig.injectUpdater !== false;

  return {
    notionEnv: pick(fileConfig, env, "notionEnv") || "prod",
    skillsDataSourceId,
    skillsDatabaseId: pick(fileConfig, env, "skillsDatabaseId") || "",
    changeRequestsDataSourceId:
      pick(fileConfig, env, "changeRequestsDataSourceId") || "",
    githubRepo,
    githubBranch: pick(fileConfig, env, "githubBranch") || "main",
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
    pluginsDir: pick(fileConfig, env, "pluginsDir") || "plugins",
    authorName: pick(fileConfig, env, "authorName") || "notion-skills-sync",
    authorEmail:
      pick(fileConfig, env, "authorEmail") ||
      "notion-skills-sync@users.noreply.github.com",
    injectUpdater,
    updaterSlug: pick(fileConfig, env, "updaterSlug") || "notion-skill-updater",
  };
}

export function loadConfig(): Config {
  return resolveConfig(loadFileConfig(), process.env);
}
