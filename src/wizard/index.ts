import pc from "picocolors";
import { WizardLogger } from "./logger.ts";
import { ClackIO, type WizardIO } from "./io.ts";
import { SetupAbortError } from "./handoff.ts";
import { stepWelcome } from "./steps/welcome.ts";
import { stepPreflight } from "./steps/preflight.ts";
import { stepDecisions, type Decisions } from "./steps/decisions.ts";
import { stepCreateResources, type Resources } from "./steps/resources.ts";
import { stepCredentials } from "./steps/credentials.ts";
import { stepDeploy } from "./steps/deploy.ts";
import { stepWrapup } from "./steps/wrapup.ts";
import { stepCleanup } from "./steps/cleanup.ts";
import { runNonInteractive } from "./non-interactive.ts";

export interface WizardOptions {
  notionEnv?: string;
  ci?: boolean;
  /** Real setup end to end, plus a final step that helps delete the created GitHub repos. */
  testRun?: boolean;
  // Non-interactive overrides
  githubRepo?: string;
  dbName?: string;
  parentPageId?: string;
}

export interface SetupFlowOptions {
  notionEnv: string;
  dbName?: string;
  /** Show the test-run cleanup tail is handled by the caller, not the flow. */
  testRun?: boolean;
}

export interface SetupFlowResult {
  status: "completed" | "cancelled";
  /** Suggested process exit code for a CLI wrapper (0 = clean stop, 1 = failure). */
  exitCode: number;
  /** Present once the decisions step succeeds — needed for test-run cleanup. */
  decisions?: Decisions;
  /** Present once resources are created. */
  resources?: Resources;
}

/**
 * The six-phase setup flow, driven entirely through a {@link WizardIO} so the
 * exact same sequence and copy powers both the terminal (`ClackIO`) and the
 * local web app (`WebIO`). It never calls `process.exit`: a user cancel returns
 * `status: "cancelled"`, and a real failure throws {@link SetupAbortError}
 * (already rendered + logged by `abortWithHandoff`). The caller decides what to
 * do with either outcome.
 *
 *   1. Preflight    — tool checks + CLI auth
 *   2. Decisions    — every question, then one plan confirmation
 *   3. Resources    — create the Notion Skills DB, skills repo, sync script repo
 *   4. Credentials  — the single manual pause: two dedicated, minimally-scoped
 *                     tokens (both verified, never the cached CLI credentials)
 *   5. Deploy       — config, push, secrets, test sync, live Actions run
 *   6. Wrapup       — register the marketplace in Claude
 *
 * The credentials pause sits after resource creation on purpose: the
 * fine-grained PAT needs the skills repo to exist to scope to it, and the
 * Notion integration needs the Skills DB to exist to connect to it.
 */
export async function runSetupFlow(
  io: WizardIO,
  logger: WizardLogger,
  opts: SetupFlowOptions,
): Promise<SetupFlowResult> {
  logger.setStep("welcome");
  const proceed = await stepWelcome(io);
  logger.event("prompt-result", { prompt: "ready-to-begin", value: proceed });
  if (!proceed) return { status: "cancelled", exitCode: 0 };

  // Phase 1: Preflight
  logger.setStep("preflight");
  const preflight = await stepPreflight(io, logger, opts.notionEnv);
  logger.event("step-result", { step: "preflight", ok: Boolean(preflight) });
  if (!preflight) {
    io.info(`Fix the issue above, then re-run: ${pc.cyan("bun run setup")}`);
    return { status: "cancelled", exitCode: 1 };
  }

  // Phase 2: Decisions (ends with the single plan confirmation)
  logger.setStep("decisions");
  const decisions = await stepDecisions(
    io,
    logger,
    preflight,
    opts.dbName,
    opts.testRun,
  );
  logger.event("step-result", { step: "decisions", ok: Boolean(decisions) });
  if (!decisions) return { status: "cancelled", exitCode: 0 };

  // Phase 3: Create resources (unattended; failures abort with a handoff)
  logger.setStep("resources");
  const resources = await stepCreateResources(io, logger, opts.notionEnv, decisions);

  // Phase 4: Credentials checkpoint (the one manual pause)
  logger.setStep("credentials");
  const credentials = await stepCredentials(io, logger, opts.notionEnv, {
    skillsRepo: decisions.skillsRepo.repo,
    dataSourceId: resources.dataSourceId,
    databaseUrl: resources.databaseUrl,
    dbName: decisions.dbName,
  });
  logger.event("step-result", { step: "credentials", ok: Boolean(credentials) });
  if (!credentials) return { status: "cancelled", exitCode: 0, decisions, resources };

  // Phase 5: Deploy tail (unattended; failures abort with a handoff)
  logger.setStep("deploy");
  await stepDeploy(io, logger, {
    skillsRepo: decisions.skillsRepo.repo,
    syncRepo: decisions.syncScriptRepo.repo,
    syncRepoDefaultBranch: resources.syncRepoDefaultBranch,
    dataSourceId: resources.dataSourceId,
    databaseId: resources.databaseId,
    notionToken: credentials.notionToken,
    githubToken: credentials.githubToken,
    notionEnv: opts.notionEnv,
  });

  // Phase 6: Wrapup
  logger.setStep("wrapup");
  await stepWrapup(io, logger, {
    dbName: decisions.dbName,
    databaseUrl: resources.databaseUrl,
    skillsRepo: decisions.skillsRepo.repo,
    skillsRepoUrl: resources.skillsRepoUrl,
    syncRepo: decisions.syncScriptRepo.repo,
    logPath: logger.getPath(),
  });

  return { status: "completed", exitCode: 0, decisions, resources };
}

/**
 * Terminal entry point: wires up `ClackIO` + a logger, runs the shared flow,
 * and maps its outcome to process exit codes / the test-run cleanup tail.
 */
export async function runWizard(opts?: WizardOptions): Promise<void> {
  if (opts?.ci) {
    await runNonInteractive(opts ?? {});
    return;
  }

  // Everything runs against prod by default; dev is opt-in via `--env dev`.
  const notionEnv = opts?.notionEnv || "prod";

  const io: WizardIO = new ClackIO();
  const logger = new WizardLogger();

  console.clear();

  // Tell the user (and any diagnosing agent) where the log lives, up front —
  // so it's discoverable even if a later step crashes.
  io.message(
    pc.dim(`Setup log: ${logger.getPath()}\n`) +
      pc.dim(`If anything goes wrong, share this file — it captures every step.`),
  );

  try {
    const result = await runSetupFlow(io, logger, {
      notionEnv,
      dbName: opts?.dbName,
      testRun: opts?.testRun,
    });

    if (result.status === "cancelled") {
      logger.finalize();
      process.exit(result.exitCode);
    }

    logger.finalize();

    // Test-run tail: everything above was real; now help tear it down.
    if (opts?.testRun && result.decisions && result.resources) {
      logger.setStep("cleanup");
      await stepCleanup(io, logger, {
        skillsRepo: result.decisions.skillsRepo,
        syncScriptRepo: result.decisions.syncScriptRepo,
        dbName: result.decisions.dbName,
        databaseUrl: result.resources.databaseUrl,
      });
      logger.finalize();
    }
  } catch (err) {
    if (err instanceof SetupAbortError) {
      // abortWithHandoff already rendered the failure + finalized the log.
      process.exit(1);
    }
    // Record the crash with full context before anything tears down.
    logger.crash(err, "runWizard");
    logger.finalize();
    io.error(
      `Setup crashed unexpectedly: ${pc.dim(err instanceof Error ? err.message : String(err))}`,
    );
    io.info(`Full diagnostic log written to:\n  ${pc.cyan(logger.getPath())}`);
    process.exit(1);
  }
}
