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

  // Everything runs against prod by default; dev is opt-in via `--env dev`.
  const notionEnv = opts?.notionEnv || "prod";

  const logger = new WizardLogger();

  console.clear();

  // Tell the user (and any diagnosing agent) where the log lives, up front —
  // so it's discoverable even if a later step crashes.
  p.log.message(
    pc.dim(`Setup log: ${logger.getPath()}\n`) +
      pc.dim(`If anything goes wrong, share this file — it captures every step.`),
  );

  try {
    // Step 1: Welcome
    logger.setStep("welcome");
    const proceed = await stepWelcome();
    logger.event("prompt-result", { prompt: "ready-to-begin", value: proceed });
    if (!proceed) {
      logger.finalize();
      process.exit(0);
    }

    // Step 2: Create Notion database
    logger.setStep("notion-db");
    const notionResult = await stepCreateNotionDb(logger, notionEnv);
    logger.event("step-result", { step: "notion-db", ok: Boolean(notionResult) });
    if (!notionResult) {
      p.log.error("Setup cannot continue without a Notion database.");
      p.log.info(
        `Fix the issue above, then re-run: ${pc.cyan("bun run wizard")}`,
      );
      logger.finalize();
      process.exit(1);
    }

    // Step 3: Create GitHub repo
    logger.setStep("github-repo");
    const githubResult = await stepCreateGithubRepo(logger);
    logger.event("step-result", { step: "github-repo", ok: Boolean(githubResult) });
    if (!githubResult) {
      p.log.error("Setup cannot continue without a GitHub repository.");
      p.log.info(
        `Fix the issue above, then re-run: ${pc.cyan("bun run wizard")}`,
      );
      logger.finalize();
      process.exit(1);
    }

    // Step 4: Set up tokens
    logger.setStep("tokens");
    const tokensResult = await stepTokens(
      logger,
      githubResult.repo,
      notionResult.databaseId,
      notionEnv,
    );
    logger.event("step-result", { step: "tokens", ok: Boolean(tokensResult) });
    if (!tokensResult) {
      p.log.error("Setup cannot continue without authentication tokens.");
      p.log.info(
        `Fix the issue above, then re-run: ${pc.cyan("bun run wizard")}`,
      );
      logger.finalize();
      process.exit(1);
    }

    // Register the tokens as secrets so they're scrubbed from all logs.
    logger.registerSecret(tokensResult.notionToken);
    logger.registerSecret(tokensResult.githubToken);

    // Step 5: Configure and deploy
    logger.setStep("deploy");
    const deployResult = await stepDeploy(logger, {
      repo: githubResult.repo,
      dataSourceId: notionResult.dataSourceId,
      databaseId: notionResult.databaseId,
      notionToken: tokensResult.notionToken,
      githubToken: tokensResult.githubToken,
      notionEnv,
    });
    logger.event("step-result", { step: "deploy", ok: Boolean(deployResult) });
    if (!deployResult) {
      logger.finalize();
      process.exit(1);
    }

    // Step 6: Wrap up
    logger.setStep("wrapup");
    const logPath = logger.finalize();
    await stepWrapup({
      databaseUrl: notionResult.databaseUrl,
      repoUrl: githubResult.repoUrl,
      testSyncPassed: deployResult.testSyncPassed,
      logPath,
    });
  } catch (err) {
    // Record the crash with full context before anything tears down.
    logger.crash(err, "runWizard");
    logger.finalize();
    p.log.error(
      `Setup crashed unexpectedly: ${pc.dim(err instanceof Error ? err.message : String(err))}`,
    );
    p.log.info(
      `Full diagnostic log written to:\n  ${pc.cyan(logger.getPath())}`,
    );
    process.exit(1);
  }
}
