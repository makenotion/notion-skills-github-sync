// One-time migration off a legacy committed config.json: copy its settings
// into `.env` (local runs) and the sync repo's Actions *variables* (the
// workflow), which is where configuration lives now. config.json itself is no
// longer read — see config.ts.
//
// The command never overwrites: a key already set in .env (or a failure to
// write a variable) is reported, not clobbered. Tokens never lived in
// config.json, so only non-secret settings move; the two secrets
// (NOTION_API_TOKEN, GH_PUSH_TOKEN) stay wherever they already are.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_JSON_TO_ENV, ciVariableName } from "./config.ts";
import { mergeEnvFile } from "./env-file.ts";

export interface MigrationPlan {
  /** `[ENV_NAME, value]` for every migratable setting the file sets. */
  settings: Array<[name: string, value: string]>;
  /** Keys with no replacing variable — reported, never silently dropped. */
  unknownKeys: string[];
}

/** Pure: which variables a config.json's contents map to. */
export function planMigration(configJson: string): MigrationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("config.json is not a JSON object.");
  }

  const settings: Array<[string, string]> = [];
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    const name = CONFIG_JSON_TO_ENV[key];
    if (!name) {
      unknownKeys.push(key);
      continue;
    }
    if (value === null || value === undefined || String(value).trim() === "") continue;
    settings.push([name, String(value)]);
  }
  return { settings, unknownKeys };
}

/** Pure: `owner/name` out of an https or ssh github.com remote URL. */
export function repoFromOriginUrl(url: string): string | undefined {
  const match = url.trim().match(/github\.com[:/]+([^/:]+\/[^/:]+?)(?:\.git)?\/?$/);
  return match?.[1];
}

export interface MigrateConfigOptions {
  cwd?: string;
  /** Sync repo (owner/name) whose Actions variables to set. Default: detected from `origin`. */
  repo?: string;
  /** Write .env only; skip the repo variables. */
  envOnly?: boolean;
  log?: (message: string) => void;
  /** Injectable for tests. */
  exec?: (cmd: string, args: string[]) => { code: number; stderr: string; stdout: string };
}

function realExec(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function runMigrateConfig(opts: MigrateConfigOptions = {}): void {
  const log = opts.log ?? ((m: string) => console.log(m));
  const exec = opts.exec ?? realExec;
  const cwd = opts.cwd ?? process.cwd();

  const configPath = join(cwd, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`No config.json found in ${cwd} — nothing to migrate.`);
  }
  const { settings, unknownKeys } = planMigration(readFileSync(configPath, "utf-8"));
  if (unknownKeys.length) {
    log(`⚠ Ignoring keys with no matching setting: ${unknownKeys.join(", ")}`);
  }
  if (settings.length === 0) {
    throw new Error("config.json sets nothing that maps to a setting — nothing to migrate.");
  }

  // --- .env (local runs) ---
  const envPath = join(cwd, ".env");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const merged = mergeEnvFile(existing, [
    "# Migrated from config.json by `bun run migrate-config`.",
    ...settings.map(([name, value]) => `${name}=${value}`),
  ]);
  writeFileSync(envPath, merged.content, "utf-8");
  log(
    `✓ .env: wrote ${merged.written.length} setting(s)` +
      (merged.skipped.length
        ? `; left ${merged.skipped.length} already set (${merged.skipped.join(", ")})`
        : "") +
      ".",
  );

  // --- Actions variables (the workflow) ---
  if (!opts.envOnly) {
    const repo = opts.repo ?? detectOriginRepo(exec);
    if (!repo) {
      throw new Error(
        ".env is written, but the sync repo for the workflow's variables couldn't be\n" +
          "detected from `git remote get-url origin`. Re-run with --repo <owner/name>,\n" +
          "or with --env-only to skip the GitHub side.",
      );
    }
    const failures: string[] = [];
    for (const [name, value] of settings) {
      const varName = ciVariableName(name);
      const r = exec("gh", ["variable", "set", varName, "--repo", repo, "--body", value]);
      if (r.code !== 0) failures.push(`${varName}: ${r.stderr.trim() || "failed"}`);
      else log(`✓ ${repo}: set variable ${varName}`);
    }
    if (failures.length) {
      throw new Error(
        `Could not set these variables on ${repo} via \`gh variable set\` (is \`gh\` \n` +
          `installed and authenticated with access to the repo?):\n` +
          failures.map((f) => `  - ${f}`).join("\n"),
      );
    }
  }

  log(
    "\nDone. Two things this command deliberately does not touch:\n" +
      "  - Secrets: NOTION_API_TOKEN must be set in .env for local runs; the repo\n" +
      "    secrets (NOTION_API_TOKEN, GH_PUSH_TOKEN) are unchanged.\n" +
      "  - config.json itself. It is no longer read; remove it with:\n" +
      "      git rm config.json && git commit -m 'Migrate config.json to environment variables'",
  );
}

function detectOriginRepo(exec: NonNullable<MigrateConfigOptions["exec"]>): string | undefined {
  const r = exec("git", ["remote", "get-url", "origin"]);
  if (r.code !== 0) return undefined;
  return repoFromOriginUrl(r.stdout);
}
