// One-time migration off a legacy committed config.json: copy its settings
// into `.env` (local runs) and the sync repo's Actions *variables* (the
// workflow), which is where configuration lives now. config.json itself is no
// longer read — see config.ts.
//
// The command never overwrites: a key already set in .env (or a failure to
// write a variable) is reported, not clobbered. Tokens never lived in
// config.json, so only non-secret settings move; the two secrets
// (NOTION_API_TOKEN, GH_PUSH_TOKEN) stay wherever they already are.
//
// After a FULL migration (both .env and the repo variables) the file is
// removed and the removal committed — nothing depends on it any more, and it
// stays recoverable in git history. `--env-only` keeps it on purpose: a
// leftover config.json is the tripwire that makes a workflow with no
// variables fail loudly instead of running on defaults (see loadConfig).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_JSON_TO_ENV, ciVariableName } from "./config.ts";
import { envFileSets, mergeEnvFile } from "./env-file.ts";

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

function realExec(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function runMigrateConfig(opts: MigrateConfigOptions = {}): void {
  const log = opts.log ?? ((m: string) => console.log(m));
  const cwd = opts.cwd ?? process.cwd();
  const exec = opts.exec ?? ((cmd: string, args: string[]) => realExec(cmd, args, cwd));

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

    // Both halves are in place, so nothing reads the file any more — remove it
    // (it stays in git history). -f because the values it held, committed or
    // not, were just written to .env.
    removeConfigJson(configPath, exec, log);

    log(
      "\n✓ Migration complete — no further steps. The scheduled workflow has\n" +
        "  everything it needs: these settings as repo variables, plus the two\n" +
        "  secrets (NOTION_API_TOKEN, GH_PUSH_TOKEN) it already had.",
    );
    logLocalTokenHint(merged.content, log);
    return;
  }

  log(
    "\nDone (--env-only). config.json is kept in this mode: while the workflow's\n" +
      "variables are unset, a leftover config.json makes the sync fail loudly\n" +
      "instead of running on defaults. Once the variables are set, remove it:\n" +
      "  git rm config.json && git commit -m 'Migrate config.json to environment variables'",
  );
  logLocalTokenHint(merged.content, log);
}

/**
 * Local runs need NOTION_API_TOKEN (the workflow reads its secret instead).
 * Only worth mentioning when it isn't already set somewhere — and then only
 * as an option, not a task.
 */
function logLocalTokenHint(envContent: string, log: (message: string) => void): void {
  const tokenSet =
    envFileSets(envContent, "NOTION_API_TOKEN") ||
    Boolean(process.env.NOTION_API_TOKEN?.trim());
  if (tokenSet) return;
  log(
    "\nOptional — only if you want to run the sync from this machine\n" +
      "(bun run dry-run / bun run sync): set NOTION_API_TOKEN in .env. You can\n" +
      "copy the token from your Notion connection's settings (Notion →\n" +
      "Settings → Connections).",
  );
}

function removeConfigJson(
  configPath: string,
  exec: NonNullable<MigrateConfigOptions["exec"]>,
  log: (message: string) => void,
): void {
  const rm = exec("git", ["rm", "-f", "-q", "config.json"]);
  if (rm.code === 0) {
    const commit = exec("git", [
      "commit",
      "-q",
      "-m",
      "Remove config.json (settings migrated to environment variables)",
      "--",
      "config.json",
    ]);
    if (commit.code === 0) {
      log("✓ Removed config.json and committed the removal (it stays in git history).");
    } else {
      log(
        "✓ Removed config.json (staged). Committing failed — finish with:\n" +
          `    git commit -m 'Remove config.json'\n  ${commit.stderr.trim()}`,
      );
    }
    return;
  }
  // Not a tracked file (or not a git repo at all) — plain delete is all there is.
  try {
    unlinkSync(configPath);
    log("✓ Removed config.json (it was not tracked by git).");
  } catch (err) {
    log(`⚠ Could not remove config.json — delete it by hand. ${(err as Error).message}`);
  }
}

function detectOriginRepo(exec: NonNullable<MigrateConfigOptions["exec"]>): string | undefined {
  const r = exec("git", ["remote", "get-url", "origin"]);
  if (r.code !== 0) return undefined;
  return repoFromOriginUrl(r.stdout);
}
