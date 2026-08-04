// Configuration, from the environment.
//
// Every setting is an environment variable. Locally that means `.env` (Bun loads
// it automatically); in CI it means repo **variables** for the non-secret
// settings and **secrets** for the two tokens.
//
// Why not a committed config.json: several teams run copies of this same sync
// repo, and a committed config file makes every copy diverge on exactly one
// file — which is also what makes `update` conflict on every merge. `.env` is
// gitignored, so it never participates in a merge at all.
//
// config.json is still read as a **deprecated fallback** so existing deployments
// keep working: env wins key by key, and a warning names the variables that
// replace whatever the file still supplies. `setup --migrate-config` converts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ENV, type NotionEnv } from "./notion/env.ts";
import type { SyncSettings } from "./sync/engine.ts";

export interface Config {
  notion: {
    env: NotionEnv;
    token: string | undefined;
    /** Overrides the env-derived API host. Escape hatch for local servers. */
    baseUrl: string | undefined;
  };
  github: {
    repo: string; // "owner/name"
    branch: string;
    token: string | undefined;
    authorName: string;
    authorEmail: string;
  };
  sync: SyncSettings;
  /** Merge and push `upstream` before syncing (CI). */
  autoUpdate: boolean;
}

/**
 * The deprecated config.json keys, each with the variable that replaces it.
 * Single source of truth for the deprecation warning and for `--migrate-config`.
 */
export const CONFIG_JSON_TO_ENV: Record<string, string> = {
  notionEnv: "NOTION_ENV",
  githubRepo: "GITHUB_REPO",
  githubBranch: "GITHUB_BRANCH",
  pluginsDir: "PLUGINS_DIR",
  pluginSlug: "PLUGIN_SLUG",
  skillsDatabaseId: "SKILLS_DATABASE_ID",
  skillsDataSourceId: "SKILLS_DATA_SOURCE_ID",
  changeRequestsDataSourceId: "CHANGE_REQUESTS_DATA_SOURCE_ID",
  authorName: "GIT_AUTHOR_NAME",
  authorEmail: "GIT_AUTHOR_EMAIL",
  injectUpdater: "INJECT_UPDATER",
  updaterSlug: "UPDATER_SLUG",
};

/** Non-secret settings, in the order a generated `.env` lists them. */
export const ENV_VARS = [
  "NOTION_ENV",
  "GITHUB_REPO",
  "GITHUB_BRANCH",
  "PLUGINS_DIR",
  "PLUGIN_SLUG",
  "SKILLS_DATABASE_ID",
  "SKILLS_DATA_SOURCE_ID",
  "CHANGE_REQUESTS_DATA_SOURCE_ID",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "INJECT_UPDATER",
  "UPDATER_SLUG",
  "AUTO_UPDATE",
] as const;

export interface FileConfig {
  notionEnv?: string;
  githubRepo?: string;
  githubBranch?: string;
  pluginsDir?: string;
  pluginSlug?: string;
  skillsDatabaseId?: string;
  skillsDataSourceId?: string;
  changeRequestsDataSourceId?: string;
  authorName?: string;
  authorEmail?: string;
  injectUpdater?: boolean;
  updaterSlug?: string;
}

export const CONFIG_JSON = "config.json";

/** Read config.json if it's there. Absent is the expected, healthy case. */
export function readFileConfig(cwd: string = process.cwd()): FileConfig | null {
  const path = join(cwd, CONFIG_JSON);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FileConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse ${CONFIG_JSON}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The warning printed when a config.json is still in play, naming the variables
 * that replace the keys it actually contains. Pure so it can be tested and
 * reused by the migrate command.
 */
export function configJsonDeprecation(file: FileConfig): string {
  const present = Object.keys(CONFIG_JSON_TO_ENV).filter(
    (key) => (file as Record<string, unknown>)[key] !== undefined,
  );
  const lines = [
    `⚠ ${CONFIG_JSON} is deprecated — configuration now comes from environment variables.`,
    `  Environment variables win; these keys are still being read from the file:`,
  ];
  for (const key of present) lines.push(`    ${key} -> ${CONFIG_JSON_TO_ENV[key]}`);
  lines.push(
    `  Convert it with:  bun run setup --migrate-config`,
    `  Then delete ${CONFIG_JSON} and commit the removal.`,
  );
  return lines.join("\n");
}

function env(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Env, else the deprecated file, else the default. */
function pick(name: string, fileValue: string | undefined, fallback: string): string {
  return env(name) ?? fileValue?.trim() ?? fallback;
}

/** Booleans accept the usual spellings; anything else is an error, not a false. */
export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`Expected a boolean (true/false), got "${value}".`);
}

export interface LoadConfigOptions {
  /** Where to look for the deprecated config.json. */
  cwd?: string;
  /** Deprecation notice sink. Defaults to console.warn. */
  warn?: (message: string) => void;
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const file = readFileConfig(opts.cwd) ?? {};
  if (Object.keys(file).length > 0) warn(configJsonDeprecation(file));

  const repo = pick("GITHUB_REPO", file.githubRepo, "");
  if (!repo) {
    throw new Error(
      "Missing GITHUB_REPO — the repo the plugins are published to, as 'owner/name'.\n" +
        "  Set it in .env for local runs, or as a repo variable for the workflow.\n" +
        "  See .env.example for the full list of settings.",
    );
  }

  const notionEnv = pick("NOTION_ENV", file.notionEnv, DEFAULT_ENV);

  return {
    notion: {
      env: notionEnv,
      token: env("NOTION_API_TOKEN"),
      baseUrl: env("NOTION_BASE_URL"),
    },
    github: {
      repo,
      branch: pick("GITHUB_BRANCH", file.githubBranch, "main"),
      token: env("GITHUB_TOKEN"),
      authorName: pick("GIT_AUTHOR_NAME", file.authorName, "notion-skills-sync"),
      authorEmail: pick(
        "GIT_AUTHOR_EMAIL",
        file.authorEmail,
        "notion-skills-sync@users.noreply.github.com",
      ),
    },
    sync: {
      notionEnv,
      pluginsDir: pick("PLUGINS_DIR", file.pluginsDir, "plugins"),
      pluginSlug: pick("PLUGIN_SLUG", file.pluginSlug, "skills"),
      // Neither id is needed to *read* skills — the Skills API scopes to the
      // token's workspace. They're the marker's back-reference and the injected
      // updater's write-back guidance.
      skillsDatabaseId: pick("SKILLS_DATABASE_ID", file.skillsDatabaseId, ""),
      skillsDataSourceId: pick("SKILLS_DATA_SOURCE_ID", file.skillsDataSourceId, ""),
      changeRequestsDataSourceId: pick(
        "CHANGE_REQUESTS_DATA_SOURCE_ID",
        file.changeRequestsDataSourceId,
        "",
      ),
      injectUpdater: parseBool(
        env("INJECT_UPDATER") ?? boolToEnv(file.injectUpdater),
        true,
      ),
      updaterSlug: pick("UPDATER_SLUG", file.updaterSlug, "notion-skill-updater"),
    },
    autoUpdate: parseBool(env("AUTO_UPDATE"), true),
  };
}

function boolToEnv(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

/**
 * `.env` lines and `gh variable set` commands equivalent to a config.json.
 * Pure, so `setup --migrate-config` is a thin shell around it.
 */
export function migrationPlan(
  file: FileConfig,
  opts: { syncRepo?: string } = {},
): { envLines: string[]; ghCommands: string[] } {
  const values: Array<[string, string]> = [];
  for (const [key, name] of Object.entries(CONFIG_JSON_TO_ENV)) {
    const value = (file as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === "") continue;
    values.push([name, String(value)]);
  }

  const envLines = [
    "# Non-secret settings, migrated from config.json.",
    "# Secrets (NOTION_API_TOKEN, GITHUB_TOKEN) stay out of version control too —",
    "# see .env.example.",
    ...values.map(([name, value]) => `${name}=${value}`),
  ];

  const repoFlag = opts.syncRepo ? ` --repo ${opts.syncRepo}` : "";
  const ghCommands = values
    // A repo variable may not start with GITHUB_, so those two are set under a
    // SKILLS_ prefix and mapped back to GITHUB_* by the workflow.
    .map(([name, value]) => `gh variable set ${ciVariableName(name)}${repoFlag} --body ${shellQuote(value)}`);

  return { envLines, ghCommands };
}

/**
 * The CI variable name for a setting. GitHub rejects variable and secret names
 * beginning with `GITHUB_`, so the two that would collide are stored prefixed
 * and mapped back to the real variable in the workflow.
 */
export function ciVariableName(envName: string): string {
  return envName.startsWith("GITHUB_") ? `SKILLS_${envName}` : envName;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
