import * as p from "@clack/prompts";
import pc from "picocolors";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loggedExec } from "../exec.ts";
import type { WizardLogger } from "../logger.ts";

export interface DeployResult {
  configPath: string;
  workflowDeployed: boolean;
  testSyncPassed: boolean;
}

interface DeployInput {
  repo: string;
  dataSourceId: string;
  databaseId: string;
  notionToken: string;
  githubToken: string;
  notionEnv?: string;
}

export async function stepDeploy(
  logger: WizardLogger,
  input: DeployInput,
): Promise<DeployResult | null> {
  p.log.step(pc.bold("Step 5: Configure and deploy to GitHub Actions"));

  p.log.info(
    `Now we'll:\n` +
      `  1. Write the config file\n` +
      `  2. Set repository secrets\n` +
      `  3. Deploy the GitHub Actions workflow\n` +
      `  4. Run a test sync`,
  );

  // --- Write config.json ---
  const configSpinner = p.spinner();
  configSpinner.start("Writing config.json...");

  const notionEnv = input.notionEnv || "prod";
  const config = {
    notionEnv,
    skillsDataSourceId: input.dataSourceId,
    skillsDatabaseId: input.databaseId,
    githubRepo: input.repo,
    githubBranch: "main",
    pluginsDir: "plugins",
    authorName: "notion-skills-sync",
    authorEmail: "notion-skills-sync@users.noreply.github.com",
  };

  const configPath = join(process.cwd(), "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  configSpinner.stop("config.json written.");

  logger.log({
    timestamp: new Date().toISOString(),
    step: "deploy",
    command: `write ${configPath}`,
    exitCode: 0,
    stdout: JSON.stringify(config),
    duration_ms: 0,
  });

  // --- Set GitHub secrets ---
  p.log.message(pc.bold("\nSetting repository secrets"));

  const setSecrets = await p.confirm({
    message: `Set NOTION_API_TOKEN and GH_PUSH_TOKEN as secrets on ${pc.cyan(input.repo)}?`,
    initialValue: true,
  });

  let secretsSet = false;
  if (!p.isCancel(setSecrets) && setSecrets) {
    const secretSpinner = p.spinner();
    secretSpinner.start("Setting repository secrets...");

    // Determine which repo to set secrets on — this is the sync-script repo itself,
    // not the target. The workflow runs in the sync-script repo.
    // We need to figure out which repo we're currently in.
    const currentRepoResult = await loggedExec(logger, "deploy", "gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]);
    const syncRepoName = currentRepoResult.code === 0
      ? currentRepoResult.stdout.trim()
      : null;

    if (!syncRepoName) {
      secretSpinner.stop("Could not determine current repo.");
      p.log.warn(
        `Couldn't detect the current repository. You'll need to set secrets manually:\n` +
          `  ${pc.cyan(`gh secret set NOTION_API_TOKEN --repo <sync-repo>`)}` +
          `  ${pc.cyan(`gh secret set GH_PUSH_TOKEN --repo <sync-repo>`)}`,
      );
    } else {
      // Set NOTION_API_TOKEN
      const notionSecretResult = await loggedExec(
        logger,
        "deploy",
        "bash",
        ["-c", `printf '%s' "$SECRET_VALUE" | gh secret set NOTION_API_TOKEN --repo "${syncRepoName}"`],
        { env: { SECRET_VALUE: input.notionToken } },
      );

      // Set GH_PUSH_TOKEN
      const ghSecretResult = await loggedExec(
        logger,
        "deploy",
        "bash",
        ["-c", `printf '%s' "$SECRET_VALUE" | gh secret set GH_PUSH_TOKEN --repo "${syncRepoName}"`],
        { env: { SECRET_VALUE: input.githubToken } },
      );

      if (notionSecretResult.code === 0 && ghSecretResult.code === 0) {
        secretSpinner.stop("Repository secrets set.");
        secretsSet = true;
      } else {
        secretSpinner.stop("Some secrets may not have been set.");
        p.log.warn(
          `There was an issue setting secrets. You may need to set them manually:\n` +
            `  ${pc.cyan(`gh secret set NOTION_API_TOKEN --repo ${syncRepoName}`)}` +
            `  ${pc.cyan(`gh secret set GH_PUSH_TOKEN --repo ${syncRepoName}`)}`,
        );
      }
    }
  } else {
    p.log.info(
      `Skipped. You'll need to set these secrets before the workflow can run:\n` +
        `  • NOTION_API_TOKEN\n` +
        `  • GH_PUSH_TOKEN`,
    );
  }

  // --- Verify GitHub Actions workflow exists ---
  p.log.message(pc.bold("\nGitHub Actions workflow"));

  const workflowPath = join(process.cwd(), ".github", "workflows", "sync.yml");
  const workflowExists = existsSync(workflowPath);

  if (workflowExists) {
    p.log.success(
      `Workflow file found at ${pc.dim(".github/workflows/sync.yml")}\n` +
        `${pc.dim("Runs hourly and on manual dispatch.")}`,
    );
  } else {
    p.log.warn(
      `No workflow file found at .github/workflows/sync.yml\n` +
        `You'll need to commit and push this repository to activate the workflow.`,
    );
  }

  // --- Run test sync ---
  p.log.message(pc.bold("\nTest sync"));

  const runTest = await p.confirm({
    message: "Run a test sync now? (dry-run first, then actual sync)",
    initialValue: true,
  });

  let testSyncPassed = false;
  if (!p.isCancel(runTest) && runTest) {
    // Dry run first
    const dryRunSpinner = p.spinner();
    dryRunSpinner.start("Running dry-run sync...");

    const dryRunResult = await loggedExec(
      logger,
      "deploy",
      "bun",
      ["run", "src/cli.ts", "sync", "--dry-run"],
      { env: { GITHUB_TOKEN: input.githubToken } },
    );

    if (dryRunResult.code !== 0) {
      dryRunSpinner.stop("Dry-run failed.");
      p.log.error(
        `Dry-run encountered errors:\n${pc.dim(dryRunResult.stderr || dryRunResult.stdout)}`,
      );

      const continueAnyway = await p.confirm({
        message: "Continue with actual sync anyway?",
        initialValue: false,
      });
      if (p.isCancel(continueAnyway) || !continueAnyway) {
        return { configPath, workflowDeployed: workflowExists, testSyncPassed: false };
      }
    } else {
      dryRunSpinner.stop("Dry-run succeeded.");
      p.log.info(pc.dim(dryRunResult.stdout.split("\n").slice(-5).join("\n")));
    }

    // Actual sync
    const syncSpinner = p.spinner();
    syncSpinner.start("Running actual sync...");

    const syncResult = await loggedExec(
      logger,
      "deploy",
      "bun",
      ["run", "src/cli.ts", "sync"],
      { env: { GITHUB_TOKEN: input.githubToken } },
    );

    if (syncResult.code !== 0) {
      syncSpinner.stop("Sync failed.");
      p.log.error(
        `Sync encountered errors:\n${pc.dim(syncResult.stderr || syncResult.stdout)}`,
      );
    } else {
      syncSpinner.stop("Sync completed successfully!");
      p.log.success(pc.dim(syncResult.stdout.split("\n").slice(-3).join("\n")));
      testSyncPassed = true;

      // Verify idempotency
      const idempotencySpinner = p.spinner();
      idempotencySpinner.start("Verifying idempotency (re-running sync)...");

      const idemResult = await loggedExec(
        logger,
        "deploy",
        "bun",
        ["run", "src/cli.ts", "sync"],
        { env: { GITHUB_TOKEN: input.githubToken } },
      );

      if (idemResult.stdout.includes("Up to date") || idemResult.stdout.includes("no commit needed")) {
        idempotencySpinner.stop("Idempotency check passed — no unnecessary commits.");
      } else {
        idempotencySpinner.stop("Note: re-run produced changes (may be expected on first setup).");
      }
    }
  } else {
    p.log.info(
      `Skipped test sync. Run ${pc.cyan("bun run sync")} when ready.\n` +
        `Or trigger it from GitHub Actions → Run workflow.`,
    );
  }

  return {
    configPath,
    workflowDeployed: workflowExists,
    testSyncPassed,
  };
}
