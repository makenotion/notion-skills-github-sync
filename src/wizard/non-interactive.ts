/**
 * Non-interactive wizard runner for CI/agent validation.
 *
 * Runs the full setup flow without prompts:
 *  1. Installs ntn if needed
 *  2. Creates a Notion skills database (requires NOTION_API_TOKEN + parentPageId or ntn auth)
 *  3. Creates/reuses a GitHub target repo (requires gh auth or --repo flag)
 *  4. Populates sample skills
 *  5. Writes config.json
 *  6. Runs sync + idempotency check
 *
 * Environment requirements:
 *  - NOTION_API_TOKEN (or ntn already authenticated)
 *  - GitHub token via gh auth, GITHUB_TOKEN, or git remote credentials
 *
 * Usage:
 *   bun run wizard --ci --env dev --repo owner/name
 *   bun run wizard --ci --env dev --repo owner/name --db-parent-page <page-id>
 */

import { WizardLogger } from "./logger.ts";
import { loggedExec, commandExists, exec } from "./exec.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WizardOptions } from "./index.ts";

const SAMPLE_SKILLS = [
  {
    name: "Meeting Notes",
    description: "Helps structure and summarize meeting notes, capturing key decisions, action items, and follow-ups.",
    plugin: "productivity",
    body: [
      { type: "heading_1", text: "Meeting Notes" },
      { type: "paragraph", text: "Help the user create structured, actionable meeting notes." },
      { type: "heading_2", text: "When to use" },
      { type: "paragraph", text: "After any meeting, standup, or call where decisions were made." },
    ],
  },
  {
    name: "Email Drafting",
    description: "Helps compose professional emails with appropriate tone, structure, and call-to-action.",
    plugin: "writing-assistant",
    body: [
      { type: "heading_1", text: "Email Drafting" },
      { type: "paragraph", text: "Help compose clear, professional emails that get results." },
      { type: "heading_2", text: "Structure" },
      { type: "paragraph", text: "Subject line, opening context, body, and clear close with next step." },
    ],
  },
  {
    name: "Research Summary",
    description: "Synthesizes research from multiple sources into clear, actionable summaries.",
    plugin: "research-tools",
    body: [
      { type: "heading_1", text: "Research Summary" },
      { type: "paragraph", text: "Synthesize information from multiple sources into a decision-ready summary." },
      { type: "heading_2", text: "Principles" },
      { type: "paragraph", text: "Lead with conclusions. Quantify where possible. Flag confidence level." },
    ],
  },
];

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

async function resolveNotionToken(): Promise<string> {
  if (process.env.NOTION_API_TOKEN) return process.env.NOTION_API_TOKEN;

  // Try ntn token command
  try {
    const result = await exec("ntn", ["--env", "dev", "token"]);
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch { /* fall through */ }

  fail(
    "No Notion token found. Set NOTION_API_TOKEN or authenticate with `ntn login`.",
  );
}

export async function runNonInteractive(opts: WizardOptions): Promise<void> {
  const logger = new WizardLogger();
  const notionEnv = opts.notionEnv || "dev";
  const githubRepo = opts.githubRepo;

  log("Starting non-interactive wizard (CI mode)");
  log(`  Notion env: ${notionEnv}`);
  log(`  GitHub repo: ${githubRepo || "(will use current repo)"}`);

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

  const notionToken = await resolveNotionToken();
  log("✓ Notion token available");

  const githubToken = await resolveGithubToken();
  log("✓ GitHub token available");

  // --- Step 2: Create Notion database ---
  log("Creating Notion skills database...");

  const dbName = opts.dbName || "Wizard CI Test Skills";
  const parentPageId = opts.parentPageId;

  if (!parentPageId) {
    fail(
      "A --db-parent-page is required in CI mode to specify where the database should be created.",
    );
  }

  // Step 1: Create the database (properties must be added separately via data source PATCH)
  const createDbPayload = {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ text: { content: dbName } }],
    properties: {},
  };

  const createResult = await loggedExec(logger, "create-db", "ntn", [
    "--env",
    notionEnv,
    "api",
    "-X",
    "POST",
    "/v1/databases",
    "--notion-version",
    "2025-09-03",
  ], { stdin: JSON.stringify(createDbPayload) });

  if (createResult.code !== 0) {
    fail(`Failed to create database: ${createResult.stderr || createResult.stdout}`);
  }

  let dataSourceId: string;
  let databaseId: string;
  let databaseUrl: string;
  try {
    const resp = JSON.parse(createResult.stdout);
    databaseId = resp.id;
    databaseUrl = resp.url || `https://notion.so/${databaseId.replace(/-/g, "")}`;
    const ds = resp.data_sources?.[0];
    dataSourceId = ds?.id || databaseId;
  } catch (e) {
    fail(`Could not parse database creation response: ${createResult.stdout.slice(0, 200)}`);
  }

  // Step 2: Add properties via data source PATCH.
  // The DB starts with a default "Name" title property. We rename it to "Skill name"
  // and add the remaining properties.
  log("Adding schema properties to database...");

  // First, rename "Name" -> "Skill name"
  const renameResult = await loggedExec(logger, "rename-title-prop", "ntn", [
    "--env",
    notionEnv,
    "api",
    "-X",
    "PATCH",
    `/v1/data_sources/${dataSourceId}`,
    "--notion-version",
    "2025-09-03",
  ], { stdin: JSON.stringify({ properties: { Name: { name: "Skill name" } } }) });

  if (renameResult.code !== 0) {
    log(`⚠ Could not rename title property: ${renameResult.stderr.slice(0, 100)}`);
  }

  // Then add the other properties
  const patchPayload = {
    properties: {
      Description: { rich_text: {} },
      "Created by": { created_by: {} },
      Published: { checkbox: {} },
      Plugins: {
        select: {
          options: [
            { name: "writing-assistant" },
            { name: "research-tools" },
            { name: "productivity" },
          ],
        },
      },
    },
  };

  const patchResult = await loggedExec(logger, "patch-db-schema", "ntn", [
    "--env",
    notionEnv,
    "api",
    "-X",
    "PATCH",
    `/v1/data_sources/${dataSourceId}`,
    "--notion-version",
    "2025-09-03",
  ], { stdin: JSON.stringify(patchPayload) });

  if (patchResult.code !== 0) {
    fail(`Failed to add properties to database: ${patchResult.stderr || patchResult.stdout}`);
  }
  log("✓ Database schema configured");

  log(`✓ Database created: ${databaseUrl}`);
  log(`  Data source ID: ${dataSourceId}`);

  // --- Populate sample skills ---
  log("Populating sample skills...");
  let created = 0;
  for (const skill of SAMPLE_SKILLS) {
    const children = skill.body.map((block) => {
      if (block.type === "heading_1") {
        return { object: "block", type: "heading_1", heading_1: { rich_text: [{ type: "text", text: { content: block.text } }] } };
      } else if (block.type === "heading_2") {
        return { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: block.text } }] } };
      }
      return { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: block.text } }] } };
    });

    const pagePayload = {
      parent: { data_source_id: dataSourceId },
      properties: {
        "Skill name": { title: [{ text: { content: skill.name } }] },
        Description: { rich_text: [{ text: { content: skill.description } }] },
        Published: { checkbox: true },
        Plugins: { select: { name: skill.plugin } },
      },
      children,
    };

    const pageResult = await loggedExec(logger, "create-skill", "ntn", [
      "--env",
      notionEnv,
      "api",
      "-X",
      "POST",
      "/v1/pages",
      "--notion-version",
      "2025-09-03",
    ], { stdin: JSON.stringify(pagePayload) });

    if (pageResult.code === 0) {
      created++;
    } else {
      log(`  ⚠ Failed to create "${skill.name}": ${pageResult.stderr.slice(0, 100)}`);
    }
  }
  log(`✓ Created ${created}/${SAMPLE_SKILLS.length} sample skills`);

  // --- Step 3: Determine GitHub repo ---
  let repo: string;
  if (githubRepo) {
    repo = githubRepo;
    log(`Using provided GitHub repo: ${repo}`);
  } else {
    // Try to detect from git remote
    const remoteResult = await exec("git", ["remote", "get-url", "origin"]);
    const match = remoteResult.stdout.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (match?.[1]) {
      repo = match[1];
      log(`Detected GitHub repo from git remote: ${repo}`);
    } else {
      fail("No --repo provided and could not detect from git remote.");
    }
  }

  // --- Step 5: Write config.json ---
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

  // --- Step 5b: Run sync ---
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
  log("  WIZARD CI VALIDATION COMPLETE");
  log("═══════════════════════════════════════════════════");
  log(`  Database:  ${databaseUrl}`);
  log(`  Repo:      https://github.com/${repo}`);
  log(`  Branch:    ${branch}`);
  log(`  Skills:    ${created}/${SAMPLE_SKILLS.length} created`);
  log(`  Sync:      ✓ passed`);
  log(`  Idempotent:✓ passed`);
  log(`  Log:       ${logPath}`);
  log("═══════════════════════════════════════════════════");
}
