// Every setting is an environment variable: `.env` locally, repo variables +
// secrets in CI. Not a committed config.json because several teams run copies
// of this repo, and a committed file makes every copy diverge on exactly one
// file — which is what made `update` conflict on every merge.
//
// config.json is no longer read at all. It is only *detected*, so a deployment
// that never migrated fails with the mapping it needs instead of silently
// running on defaults.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ENV, type NotionEnv } from "./notion/env.ts";
import type { SyncSettings } from "./sync/engine.ts";

export interface Config {
  notion: {
    env: NotionEnv;
    token: string | undefined;
  };
  github: {
    repo: string; // "owner/name"
    branch: string;
    token: string | undefined;
    authorName: string;
    authorEmail: string;
  };
  sync: SyncSettings;
}

const CONFIG_JSON = "config.json";

/**
 * Retired config.json keys -> the variable that replaced each one. Keys whose
 * setting no longer exists at all (pluginsDir, updaterSlug, …) are deliberately
 * absent: `migrate-config` reports them as ignored, and a leftover file that
 * only sets those is a warning, not an error.
 */
export const CONFIG_JSON_TO_ENV: Record<string, string> = {
  notionEnv: "NOTION_ENV",
  githubRepo: "GITHUB_REPO",
  githubBranch: "GITHUB_BRANCH",
  skillsDataSourceId: "SKILLS_DATA_SOURCE_ID",
  authorName: "GIT_AUTHOR_NAME",
  authorEmail: "GIT_AUTHOR_EMAIL",
};

function env(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function pick(name: string, fallback: string): string {
  return env(name) ?? fallback;
}

/**
 * How many plugin archives to fetch at once. The Notion side is latency-bound
 * (one server-side render per plugin), so this is what turns a ~45-minute cold
 * sync into ~4. Not configurable — 8 has been right everywhere it's run.
 */
export const SYNC_CONCURRENCY = 8;

export interface LoadConfigOptions {
  /** Where to look for a leftover config.json. */
  cwd?: string;
  /** Notice sink. Defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * The keys a leftover config.json still sets, best-effort: an unparseable file
 * yields none, and the caller still gets the "it isn't read" message.
 */
function retiredKeys(path: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  return Object.keys(CONFIG_JSON_TO_ENV).filter(
    (key) => (parsed as Record<string, unknown>)[key] !== undefined,
  );
}

function unmigratedConfigJson(path: string, keys: string[]): string {
  const lines = [
    `${CONFIG_JSON} is no longer read — configuration comes from environment variables`,
    `  (.env for local runs, repo variables + secrets for the workflow), and the`,
    `  settings it holds have no variable set.`,
    ``,
    `  Found: ${path}`,
  ];
  if (keys.length) {
    lines.push(``, `  Set these variables instead:`);
    for (const key of keys) lines.push(`    ${key} -> ${CONFIG_JSON_TO_ENV[key]}`);
  }
  lines.push(
    ``,
    `  Run \`bun run migrate-config\` to copy the file's settings into .env and`,
    `  the repo's Actions variables in one step.`,
    `  See .env.example for the full list of settings.`,
    `  Then delete ${CONFIG_JSON} and commit the removal.`,
  );
  return lines.join("\n");
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const configJsonPath = join(opts.cwd ?? process.cwd(), CONFIG_JSON);
  const hasConfigJson = existsSync(configJsonPath);

  // The dangerous state is a *partial* migration: GITHUB_REPO moved to a
  // variable while everything else stayed in the file. Nothing there is read any
  // more, so defaulting those settings would quietly point the sync at another
  // env, branch and pluginsDir — so any retired key with no variable behind it
  // is an error, not a warning.
  const unmigrated = hasConfigJson
    ? retiredKeys(configJsonPath).filter((key) => env(CONFIG_JSON_TO_ENV[key]!) === undefined)
    : [];
  if (unmigrated.length) throw new Error(unmigratedConfigJson(configJsonPath, unmigrated));

  const repo = env("GITHUB_REPO");
  if (!repo) {
    if (hasConfigJson) throw new Error(unmigratedConfigJson(configJsonPath, []));
    throw new Error(
      "Missing GITHUB_REPO — the repo the plugins are published to, as 'owner/name'.\n" +
        "  Set it in .env for local runs, or as a repo variable for the workflow.\n" +
        "  See .env.example for the full list of settings.",
    );
  }
  if (hasConfigJson) {
    warn(
      `⚠ ${configJsonPath} is ignored — configuration comes from environment variables.\n` +
        `  Delete ${CONFIG_JSON} and commit the removal.`,
    );
  }

  const notionEnv = pick("NOTION_ENV", DEFAULT_ENV);

  return {
    notion: {
      env: notionEnv,
      token: env("NOTION_API_TOKEN"),
    },
    github: {
      repo,
      branch: pick("GITHUB_BRANCH", "main"),
      token: env("GITHUB_TOKEN"),
      authorName: pick("GIT_AUTHOR_NAME", "notion-skills-sync"),
      authorEmail: pick("GIT_AUTHOR_EMAIL", "notion-skills-sync@users.noreply.github.com"),
    },
    sync: {
      notionEnv,
      // Not needed to *read* skills (the API scopes to the token's workspace);
      // this is only the marker's back-reference into Notion.
      skillsDataSourceId: pick("SKILLS_DATA_SOURCE_ID", ""),
      concurrency: SYNC_CONCURRENCY,
    },
  };
}

/**
 * GitHub rejects variable/secret names beginning with `GITHUB_`, so the two
 * that collide are stored SKILLS_-prefixed and mapped back in the workflow.
 */
export function ciVariableName(envName: string): string {
  return envName.startsWith("GITHUB_") ? `SKILLS_${envName}` : envName;
}
