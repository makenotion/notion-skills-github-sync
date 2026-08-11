/**
 * Non-interactive setup runner for CI/agent validation.
 *
 * Runs the setup flow without prompts:
 *  1. Installs ntn if needed and verifies Notion + GitHub auth
 *  2. Creates a Notion Skills DB (shared schema/sample code with setup)
 *  3. Uses the provided/detected skills repo
 *  4. Configures the sync via environment variables
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

import { SetupLogger } from "./logger.ts";
import { exec, parseGithubRepo } from "./exec.ts";
import { createSkillsDb, populateSampleSkills, SKILLS_DB_DEFAULT_NAME } from "./skills-db.ts";
import { ensureNtnInstalled, probeNtnAuth } from "./ntn-cli.ts";
import { runVerificationSyncs, type SyncPhase } from "./verify-sync.ts";
import type { SetupOptions } from "./index.ts";

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
 * Make sure both halves of the run can talk to Notion.
 *
 * Setup itself (DB creation, file uploads) goes through `ntn`, which is happy
 * with a keychain login. The dry-run sync at the end does NOT — it calls the
 * Skills API directly and reads `NOTION_API_TOKEN` from the environment, with
 * no keychain fallback. So the token is required outright.
 */
async function ensureNotionAuth(
  logger: SetupLogger,
  notionEnv: string,
): Promise<void> {
  if (!process.env.NOTION_API_TOKEN) {
    fail(
      "NOTION_API_TOKEN is required: the sync reads the Notion Skills API directly " +
        "and has no keychain fallback. (An `ntn` login alone is not enough — it only " +
        "covers setup's DB creation.)",
    );
  }
  try {
    const probe = await probeNtnAuth(logger, "env-check", notionEnv);
    if (probe.code === 0) return;
  } catch { /* fall through */ }
  fail(
    `Notion auth unavailable. Check NOTION_API_TOKEN, or authenticate with \`ntn --env ${notionEnv} login\`.`,
  );
}

export async function runNonInteractive(opts: SetupOptions): Promise<void> {
  const logger = new SetupLogger();
  // Prod by default; dev is opt-in via `--env dev`.
  const notionEnv = opts.notionEnv || "prod";
  const githubRepo = opts.githubRepo;

  log("Starting non-interactive setup (CI mode)");
  log(`  Notion env: ${notionEnv}`);
  log(`  Skills repo: ${githubRepo || "(will use current repo)"}`);

  // --- Validate environment ---
  log("Checking environment...");

  const install = await ensureNtnInstalled(logger, "env-check", () =>
    log("Installing ntn CLI..."),
  );
  if (install.status === "failed") fail(`Failed to install ntn: ${install.stderr}`);

  await ensureNotionAuth(logger, notionEnv);
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
  const { created, total, zipsAttached, zipsTotal } = await populateSampleSkills(
    logger,
    "create-skill",
    notionEnv,
    dataSourceId,
  );
  log(`✓ Created ${created}/${total} sample skills (${zipsAttached}/${zipsTotal} file zips attached)`);

  // --- Determine the skills repo ---
  let repo: string;
  if (githubRepo) {
    repo = githubRepo;
    log(`Using provided skills repo: ${repo}`);
  } else {
    // Try to detect from git remote
    const remoteResult = await exec("git", ["remote", "get-url", "origin"]);
    const detected = parseGithubRepo(remoteResult.stdout);
    if (detected) {
      repo = detected;
      log(`Detected skills repo from git remote: ${repo}`);
    } else {
      fail("No --repo provided and could not detect from git remote.");
    }
  }

  // --- Configure the sync ---
  // No file is written: configuration is environment-only, so the child sync
  // processes below get it the same way the workflow does.
  const branch = "setup-e2e-test";
  const syncEnv: Record<string, string> = {
    GITHUB_TOKEN: githubToken,
    NOTION_ENV: notionEnv,
    GITHUB_REPO: repo,
    GITHUB_BRANCH: branch,
    SKILLS_DATABASE_ID: databaseId,
    SKILLS_DATA_SOURCE_ID: dataSourceId,
  };
  log(`✓ Sync configured via environment (repo: ${repo}, branch: ${branch})`);
  logger.event("sync-config", { ...syncEnv, GITHUB_TOKEN: "[redacted]" });

  // --- Run sync, then re-run it to prove idempotency ---
  const tail = (output: string, lines: number): void => {
    for (const line of output.trim().split("\n").slice(-lines)) log(`  ${line}`);
  };
  // One logger step per phase, so the JSONL log tells the three runs apart.
  const logSteps: Record<SyncPhase, string> = {
    "dry-run": "sync-dry-run",
    sync: "sync",
    idempotency: "sync-idempotency",
  };

  await runVerificationSyncs({
    logger,
    env: syncEnv,
    step: (phase) => logSteps[phase],
    ui: {
      begin(_phase, label) {
        log(label);
      },
      abort(phase, result) {
        const what = phase === "dry-run" ? "Dry-run" : "Sync";
        log(`⚠ ${what} output:\n${result.stdout}\n${result.stderr}`);
        fail(`${what} failed with exit code ${result.code}`);
      },
      report(phase, result) {
        if (phase === "dry-run") {
          log(`✓ Dry-run succeeded`);
          tail(result.stdout, 8);
        } else {
          log(`✓ Sync succeeded`);
          tail(result.stdout, 4);
        }
      },
      reportIdempotency(result, upToDate) {
        if (result.code !== 0) {
          log(`⚠ Idempotency check failed: ${result.stderr}`);
        } else if (upToDate) {
          log(`✓ Idempotency check passed — no unnecessary commits`);
        } else {
          log(`⚠ Idempotency check: re-run produced changes`);
          tail(result.stdout, 4);
        }
      },
    },
  });

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
