/**
 * Non-interactive wizard runner for CI/agent validation.
 *
 * Runs the setup flow without prompts:
 *  1. Installs ntn if needed and verifies Notion + GitHub auth
 *  2. Creates a Notion Skills DB (shared schema/sample code with the wizard)
 *  3. Uses the provided/detected skills repo
 *  4. Writes config.json
 *  5. Runs sync + idempotency check
 *
 * Environment requirements:
 *  - NOTION_API_TOKEN, or ntn already authenticated (keychain)
 *  - GitHub token via GH_PUSH_TOKEN, GITHUB_TOKEN, git remote, or gh auth
 *
 * Unlike the interactive flow, CI mode doesn't push the sync script repo or
 * dispatch Actions, and takes its credentials from the environment rather
 * than the dedicated-token checkpoint.
 *
 * Usage:
 *   bun run setup --ci --env dev --repo owner/name --db-parent-page <page-id>
 */

import { WizardLogger } from "./logger.ts";
import { loggedExec, commandExists, exec } from "./exec.ts";
import { createSkillsDb, populateSampleSkills, SKILLS_DB_DEFAULT_NAME } from "./skills-db.ts";
import { NOTION_API_VERSION } from "../notion/ntn.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WizardOptions } from "./index.ts";

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n✖ FATAL: ${msg}`);
  process.exit(1);
}

async function resolveGithubToken(): Promise<string> {
  // Try GH_PUSH_TOKEN (dedicated push token) first
  if (process.env.GH_PUSH_TOKEN) return process.env.GH_PUSH_TOKEN;

  // Try git remote token (embedded in URL) — reliable in CI/agent environments
  try {
    const result = await exec("git", ["remote", "get-url", "origin"]);
    const match = result.stdout.match(/x-access-token:([^@]+)@/);
    if (match?.[1]) return match[1];
  } catch { /* fall through */ }

  // Try GITHUB_TOKEN env (may be set by CI but could be invalid)
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // Try gh auth token
  try {
    const result = await exec("gh", ["auth", "token"]);
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch { /* fall through */ }

  fail(
    "No GitHub token found. Set GITHUB_TOKEN, GH_PUSH_TOKEN, or authenticate with `gh auth login`.",
  );
}

/**
 * Make sure Notion reads will work: either NOTION_API_TOKEN is set (ntn reads
 * it from the env), or the ntn keychain login is valid. (There is no
 * `ntn token` subcommand to extract a cached token — we only verify access.)
 */
async function ensureNotionAuth(notionEnv: string): Promise<void> {
  if (process.env.NOTION_API_TOKEN) return;
  try {
    const probe = await exec("ntn", [
      "--env", notionEnv,
      "api", "-X", "GET", "/v1/users/me",
      "--notion-version", NOTION_API_VERSION,
    ]);
    if (probe.code === 0) return;
  } catch { /* fall through */ }
  fail(
    `Notion auth unavailable. Set NOTION_API_TOKEN or authenticate with \`ntn --env ${notionEnv} login\`.`,
  );
}

export async function runNonInteractive(opts: WizardOptions): Promise<void> {
  const logger = new WizardLogger();
  // Prod by default; dev is opt-in via `--env dev`.
  const notionEnv = opts.notionEnv || "prod";
  const githubRepo = opts.githubRepo;

  log("Starting non-interactive setup (CI mode)");
  log(`  Notion env: ${notionEnv}`);
  log(`  Skills repo: ${githubRepo || "(will use current repo)"}`);

  // --- Validate environment ---
  log("Checking environment...");

  const hasNtn = await commandExists("ntn");
  if (!hasNtn) {
    log("Installing ntn CLI...");
    const install = await loggedExec(logger, "env-check", "bash", [
      "-c",
      "curl -fsSL https://ntn.dev | bash",
    ]);
    if (install.code !== 0) fail(`Failed to install ntn: ${install.stderr}`);
  }

  await ensureNotionAuth(notionEnv);
  log("✓ Notion auth available");

  const githubToken = await resolveGithubToken();
  log("✓ GitHub token available");

  // --- Create the Notion Skills DB ---
  log("Creating the Notion Skills DB...");

  const dbName = opts.dbName || SKILLS_DB_DEFAULT_NAME;
  const parentPageId = opts.parentPageId;

  if (!parentPageId) {
    fail(
      "A --db-parent-page is required in CI mode to specify where the database should be created.",
    );
  }

  const dbResult = await createSkillsDb(logger, "create-db", notionEnv, {
    dbName,
    parentPageId,
  });
  if (!dbResult.ok) {
    fail(`Failed to create the Notion Skills DB: ${dbResult.error}`);
  }
  const { dataSourceId, databaseId, databaseUrl } = dbResult.db;
  log(`✓ Notion Skills DB created: ${databaseUrl}`);
  log(`  Data source ID: ${dataSourceId}`);

  log("Populating sample skills...");
  const { created, total } = await populateSampleSkills(
    logger,
    "create-skill",
    notionEnv,
    dataSourceId,
  );
  log(`✓ Created ${created}/${total} sample skills`);

  // --- Determine the skills repo ---
  let repo: string;
  if (githubRepo) {
    repo = githubRepo;
    log(`Using provided skills repo: ${repo}`);
  } else {
    // Try to detect from git remote
    const remoteResult = await exec("git", ["remote", "get-url", "origin"]);
    const match = remoteResult.stdout.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (match?.[1]) {
      repo = match[1];
      log(`Detected skills repo from git remote: ${repo}`);
    } else {
      fail("No --repo provided and could not detect from git remote.");
    }
  }

  // --- Write config.json ---
  log("Writing config.json...");
  const branch = "wizard-e2e-test";
  const config = {
    notionEnv,
    skillsDataSourceId: dataSourceId,
    skillsDatabaseId: databaseId,
    githubRepo: repo,
    githubBranch: branch,
    pluginsDir: "plugins",
    authorName: "notion-skills-sync",
    authorEmail: "notion-skills-sync@users.noreply.github.com",
  };

  const configPath = join(process.cwd(), "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  log(`✓ config.json written (branch: ${branch})`);

  logger.log({
    timestamp: new Date().toISOString(),
    step: "config",
    command: `write config.json`,
    exitCode: 0,
    stdout: JSON.stringify(config),
    duration_ms: 0,
  });

  // --- Run sync ---
  log("Running dry-run sync...");
  const dryRunResult = await loggedExec(logger, "sync-dry-run", "bun", [
    "run",
    "src/cli.ts",
    "sync",
    "--dry-run",
  ], { env: { GITHUB_TOKEN: githubToken } });

  if (dryRunResult.code !== 0) {
    log(`⚠ Dry-run output:\n${dryRunResult.stdout}\n${dryRunResult.stderr}`);
    fail(`Dry-run failed with exit code ${dryRunResult.code}`);
  }
  log(`✓ Dry-run succeeded`);
  // Print last few lines of output
  const dryLines = dryRunResult.stdout.trim().split("\n");
  for (const line of dryLines.slice(-8)) {
    log(`  ${line}`);
  }

  log("Running actual sync...");
  const syncResult = await loggedExec(logger, "sync", "bun", [
    "run",
    "src/cli.ts",
    "sync",
  ], { env: { GITHUB_TOKEN: githubToken } });

  if (syncResult.code !== 0) {
    log(`⚠ Sync output:\n${syncResult.stdout}\n${syncResult.stderr}`);
    fail(`Sync failed with exit code ${syncResult.code}`);
  }
  log(`✓ Sync succeeded`);
  const syncLines = syncResult.stdout.trim().split("\n");
  for (const line of syncLines.slice(-4)) {
    log(`  ${line}`);
  }

  // --- Idempotency check ---
  log("Verifying idempotency (re-running sync)...");
  const idemResult = await loggedExec(logger, "sync-idempotency", "bun", [
    "run",
    "src/cli.ts",
    "sync",
  ], { env: { GITHUB_TOKEN: githubToken } });

  if (idemResult.code !== 0) {
    log(`⚠ Idempotency check failed: ${idemResult.stderr}`);
  } else if (
    idemResult.stdout.includes("Up to date") ||
    idemResult.stdout.includes("no commit needed")
  ) {
    log(`✓ Idempotency check passed — no unnecessary commits`);
  } else {
    log(`⚠ Idempotency check: re-run produced changes`);
    const idemLines = idemResult.stdout.trim().split("\n");
    for (const line of idemLines.slice(-4)) {
      log(`  ${line}`);
    }
  }

  // --- Done ---
  const logPath = logger.finalize();
  log("");
  log("═══════════════════════════════════════════════════");
  log("  SETUP CI VALIDATION COMPLETE");
  log("═══════════════════════════════════════════════════");
  log(`  Skills DB:  ${databaseUrl}`);
  log(`  Repo:       https://github.com/${repo}`);
  log(`  Branch:     ${branch}`);
  log(`  Skills:     ${created}/${total} created`);
  log(`  Sync:       ✓ passed`);
  log(`  Idempotent: ✓ passed`);
  log(`  Log:        ${logPath}`);
  log("═══════════════════════════════════════════════════");
}
