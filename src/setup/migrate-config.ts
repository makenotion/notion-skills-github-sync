// `setup --migrate-config`: turn a legacy config.json into environment config.
//
// Two outputs, because a deployment has two places settings live now: `.env` for
// local runs, and repo **variables** for the workflow. Existing `.env` values are
// never overwritten — the file is the user's, and a half-migrated deployment
// where the file says one thing and the tool another is worse than no migration.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CONFIG_JSON, migrationPlan, readFileConfig } from "../config.ts";

export interface MigrateResult {
  written: string[];
  skipped: string[];
  ghCommands: string[];
}

/**
 * Merge new `KEY=value` lines into an existing `.env`, leaving any key the file
 * already sets alone. Pure: takes and returns file contents.
 */
export function mergeEnvFile(
  existing: string,
  lines: string[],
): { content: string; written: string[]; skipped: string[] } {
  const present = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=")[0]?.trim())
      .filter((k): k is string => Boolean(k)),
  );

  const written: string[] = [];
  const skipped: string[] = [];
  const additions: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#") || !line.includes("=")) {
      additions.push(line);
      continue;
    }
    const key = line.split("=")[0]!.trim();
    if (present.has(key)) {
      skipped.push(key);
      continue;
    }
    written.push(key);
    additions.push(line);
  }

  // Drop trailing comment-only blocks that ended up with nothing under them.
  while (additions.length && !additions[additions.length - 1]!.includes("=")) additions.pop();
  if (additions.length === 0) return { content: existing, written, skipped };

  const prefix = existing.trim() ? `${existing.replace(/\n+$/, "")}\n\n` : "";
  return { content: `${prefix}${additions.join("\n")}\n`, written, skipped };
}

/** `owner/name` of the repo this code lives in, if git knows. */
function detectSyncRepo(): string | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return url.match(/github\.com[/:]([^/]+\/[^/.\s]+)/)?.[1];
  } catch {
    return undefined;
  }
}

export function runMigrateConfig(cwd: string = process.cwd()): MigrateResult {
  const file = readFileConfig(cwd);
  if (!file) {
    throw new Error(
      `No ${CONFIG_JSON} found in ${cwd} — nothing to migrate. ` +
        `Configuration already comes from the environment; see .env.example.`,
    );
  }

  const { envLines, ghCommands } = migrationPlan(file, { syncRepo: detectSyncRepo() });
  const envPath = join(cwd, ".env");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const merged = mergeEnvFile(existing, envLines);
  writeFileSync(envPath, merged.content, "utf-8");

  console.log(`✓ ${existing ? "Updated" : "Wrote"} .env`);
  if (merged.written.length) console.log(`  added: ${merged.written.join(", ")}`);
  if (merged.skipped.length) {
    console.log(`  left alone (already set in .env): ${merged.skipped.join(", ")}`);
  }

  console.log(
    `\nNow set the same values as repo variables on the repo the workflow runs in,\n` +
      `so CI stops depending on ${CONFIG_JSON}:\n`,
  );
  for (const cmd of ghCommands) console.log(`  ${cmd}`);
  console.log(
    `\nThe two tokens stay secrets (unchanged):\n` +
      `  gh secret set NOTION_API_TOKEN\n` +
      `  gh secret set GH_PUSH_TOKEN\n` +
      `\nThen delete ${CONFIG_JSON} and commit the removal:\n` +
      `  git rm ${CONFIG_JSON} && git commit -m "Move sync config to env vars"`,
  );

  return { written: merged.written, skipped: merged.skipped, ghCommands };
}
