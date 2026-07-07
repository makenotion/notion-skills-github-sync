import * as p from "@clack/prompts";
import pc from "picocolors";
import { WizardLogger } from "./logger.ts";
import { stepWelcome } from "./steps/welcome.ts";
import { stepCreateNotionDb } from "./steps/notion-db.ts";
import { stepCreateGithubRepo } from "./steps/github-repo.ts";
import { stepTokens } from "./steps/tokens.ts";
import { stepDeploy } from "./steps/deploy.ts";
import { stepWrapup } from "./steps/wrapup.ts";
import { runNonInteractive } from "./non-interactive.ts";

export interface WizardOptions {
  notionEnv?: string;
  ci?: boolean;
  // Non-interactive overrides
  githubRepo?: string;
  dbName?: string;
  parentPageId?: string;
}

export async function runWizard(opts?: WizardOptions): Promise<void> {
  if (opts?.ci) {
    await runNonInteractive(opts);
    return;
  }

  const logger = new WizardLogger();

  console.clear();

  // Step 1: Welcome
  const proceed = await stepWelcome();
  if (!proceed) {
    logger.finalize();
    process.exit(0);
  }

  // Step 2: Create Notion database
  const notionResult = await stepCreateNotionDb(logger);
  if (!notionResult) {
    p.log.error("Setup cannot continue without a Notion database.");
    p.log.info(
      `Fix the issue above, then re-run: ${pc.cyan("bun run wizard")}`,
    );
    logger.finalize();
    process.exit(1);
  }

  // Step 3: Create GitHub repo
  const githubResult = await stepCreateGithubRepo(logger);
  if (!githubResult) {
    p.log.error("Setup cannot continue without a GitHub repository.");
    p.log.info(
      `Fix the issue above, then re-run: ${pc.cyan("bun run wizard")}`,
    );
    logger.finalize();
    process.exit(1);
  }

  // Step 4: Set up tokens
  const tokensResult = await stepTokens(
    logger,
    githubResult.repo,
    notionResult.databaseId,
  );
  if (!tokensResult) {
    p.log.error("Setup cannot continue without authentication tokens.");
    p.log.info(
      `Fix the issue above, then re-run: ${pc.cyan("bun run wizard")}`,
    );
    logger.finalize();
    process.exit(1);
  }

  // Step 5: Configure and deploy
  const deployResult = await stepDeploy(logger, {
    repo: githubResult.repo,
    dataSourceId: notionResult.dataSourceId,
    databaseId: notionResult.databaseId,
    notionToken: tokensResult.notionToken,
    githubToken: tokensResult.githubToken,
    notionEnv: opts?.notionEnv,
  });
  if (!deployResult) {
    logger.finalize();
    process.exit(1);
  }

  // Step 6: Wrap up
  const logPath = logger.finalize();
  await stepWrapup({
    databaseUrl: notionResult.databaseUrl,
    repoUrl: githubResult.repoUrl,
    testSyncPassed: deployResult.testSyncPassed,
    logPath,
  });
}
