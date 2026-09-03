import * as p from "@clack/prompts";
import pc from "picocolors";
import { SetupLogger } from "./logger.ts";
import { stepWelcome } from "./steps/welcome.ts";
import { stepPreflight } from "./steps/preflight.ts";
import { stepDecisions } from "./steps/decisions.ts";
import { stepCreateResources } from "./steps/resources.ts";
import { stepCredentials } from "./steps/credentials.ts";
import { stepDeploy } from "./steps/deploy.ts";
import { stepWrapup } from "./steps/wrapup.ts";
import { stepCleanup } from "./steps/cleanup.ts";
import { runNonInteractive } from "./non-interactive.ts";

export interface SetupOptions {
  notionEnv?: string;
  ci?: boolean;
  /** Real setup end to end, plus a final step that helps delete the created GitHub repos. */
  testRun?: boolean;
  // Non-interactive overrides
  githubRepo?: string;
  dbName?: string;
  parentPageId?: string;
}

/**
 * Guided setup, structured to front-load all decisions and then run
 * unattended:
 *
 *   1. Preflight    — tool checks + CLI auth (interactive only if needed)
 *   2. Decisions    — every question, then one plan confirmation
 *   3. Resources    — create the Notion Skills DB, skills repo, sync script repo
 *   4. Credentials  — the single manual pause: two dedicated, minimally-scoped
 *                     tokens (both verified, never the cached CLI credentials)
 *   5. Deploy       — config, push, secrets, test sync, live Actions run
 *   6. Wrapup       — optionally connect the GitHub marketplace to agent apps
 *
 * The credentials pause sits after resource creation on purpose: the
 * fine-grained PAT needs the skills repo to exist to scope to it, and the
 * Notion integration needs the Skills DB to exist to connect to it.
 */
export async function runSetup(opts?: SetupOptions): Promise<void> {
  if (opts?.ci) {
    await runNonInteractive(opts ?? {});
    return;
  }

  // Everything runs against prod by default; dev is opt-in via `--env dev`.
  const notionEnv = opts?.notionEnv || "prod";

  const logger = new SetupLogger();

  console.clear();

  // Tell the user (and any diagnosing agent) where the log lives, up front —
  // so it's discoverable even if a later step crashes.
  p.log.message(
    pc.dim(`Setup log: ${logger.getPath()}\n`) +
      pc.dim(`If anything goes wrong, share this file — it captures every step.`),
  );

  try {
    logger.setStep("welcome");
    const proceed = await stepWelcome();
    logger.event("prompt-result", { prompt: "ready-to-begin", value: proceed });
    if (!proceed) {
      logger.finalize();
      process.exit(0);
    }

    // Phase 1: Preflight
    logger.setStep("preflight");
    const preflight = await stepPreflight(logger, notionEnv);
    logger.event("step-result", { step: "preflight", ok: Boolean(preflight) });
    if (!preflight) {
      p.log.info(
        `Fix the issue above, then re-run: ${pc.cyan("bun run setup")}`,
      );
      logger.finalize();
      process.exit(1);
    }

    // Phase 2: Decisions (ends with the single plan confirmation)
    logger.setStep("decisions");
    const decisions = await stepDecisions(
      logger,
      preflight,
      opts?.dbName,
      opts?.testRun,
      opts?.parentPageId,
    );
    logger.event("step-result", { step: "decisions", ok: Boolean(decisions) });
    if (!decisions) {
      logger.finalize();
      process.exit(0);
    }

    // Phase 3: Create resources (unattended; failures abort with a handoff)
    logger.setStep("resources");
    const resources = await stepCreateResources(logger, notionEnv, decisions);

    // Phase 4: Credentials checkpoint (the one manual pause)
    logger.setStep("credentials");
    const credentials = await stepCredentials(logger, notionEnv, {
      skillsRepo: decisions.skillsRepo.repo,
      dataSourceId: resources.dataSourceId,
      databaseUrl: resources.databaseUrl,
      dbName: decisions.dbName,
    });
    logger.event("step-result", { step: "credentials", ok: Boolean(credentials) });
    if (!credentials) {
      logger.finalize();
      process.exit(0);
    }

    // Phase 5: Deploy tail (unattended; failures abort with a handoff)
    logger.setStep("deploy");
    await stepDeploy(logger, {
      skillsRepo: decisions.skillsRepo.repo,
      syncRepo: decisions.syncScriptRepo.repo,
      syncRepoDefaultBranch: resources.syncRepoDefaultBranch,
      dataSourceId: resources.dataSourceId,
      databaseId: resources.databaseId,
      notionToken: credentials.notionToken,
      githubToken: credentials.githubToken,
      notionEnv,
    });

    // Phase 6: Wrapup
    logger.setStep("wrapup");
    const logPath = logger.finalize();
    await stepWrapup(logger, {
      dbName: decisions.dbName,
      databaseUrl: resources.databaseUrl,
      skillsRepo: decisions.skillsRepo.repo,
      skillsRepoUrl: resources.skillsRepoUrl,
      syncRepo: decisions.syncScriptRepo.repo,
      logPath,
    });

    // Test-run tail: everything above was real; now help tear it down.
    if (opts?.testRun) {
      logger.setStep("cleanup");
      await stepCleanup(logger, {
        skillsRepo: decisions.skillsRepo,
        syncScriptRepo: decisions.syncScriptRepo,
        dbName: decisions.dbName,
        databaseUrl: resources.databaseUrl,
      });
      logger.finalize();
    }
  } catch (err) {
    // Record the crash with full context before anything tears down.
    logger.crash(err, "runSetup");
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
