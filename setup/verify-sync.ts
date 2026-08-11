// The end-of-setup proof that the sync works: dry-run, then a real sync, then
// the same sync again to show it commits nothing the second time.
//
// Both setup flows run exactly this sequence, so the sequence lives here and
// each flow supplies only its presentation — spinners plus an abort-with-handoff
// interactively, timestamped log lines plus a hard exit in CI. Sharing the
// sequence is what keeps the two from drifting on the thing that matters: which
// commands run, in which order, and what counts as "idempotent".

import { loggedExec, type ExecResult } from "./exec.ts";
import type { SetupLogger } from "./logger.ts";

export type SyncPhase = "dry-run" | "sync" | "idempotency";

/** The phase that failed is always one that aborts the run. */
export type FatalPhase = Exclude<SyncPhase, "idempotency">;

const LABELS: Record<SyncPhase, string> = {
  "dry-run": "Running dry-run sync...",
  sync: "Running actual sync...",
  idempotency: "Verifying idempotency (re-running sync)...",
};

/** How a flow renders the sequence. */
export interface SyncVerificationUi {
  /** Announce a phase before its command runs. */
  begin(phase: SyncPhase, label: string): void;
  /** The dry-run or the real sync exited non-zero. Must not return. */
  abort(phase: FatalPhase, result: ExecResult): never;
  /** The dry-run or the real sync succeeded. */
  report(phase: FatalPhase, result: ExecResult): void;
  /**
   * The idempotency re-run finished. `upToDate` is the verdict; the raw result
   * is passed through because CI also distinguishes a re-run that failed
   * outright from one that merely produced changes.
   */
  reportIdempotency(result: ExecResult, upToDate: boolean): void;
}

/** The sync's own "nothing to do" wording — either spelling counts. */
function isUpToDate(stdout: string): boolean {
  return stdout.includes("Up to date") || stdout.includes("no commit needed");
}

export async function runVerificationSyncs(opts: {
  logger: SetupLogger;
  /** Credentials/settings the child sync processes run with. */
  env: Record<string, string>;
  /** Logger step name per phase (diagnostic only). */
  step: (phase: SyncPhase) => string;
  ui: SyncVerificationUi;
}): Promise<void> {
  const { logger, env, step, ui } = opts;
  const run = (phase: SyncPhase, extra: string[]) =>
    loggedExec(logger, step(phase), "bun", ["run", "src/cli.ts", "sync", ...extra], {
      env,
    });

  ui.begin("dry-run", LABELS["dry-run"]);
  const dryRun = await run("dry-run", ["--dry-run"]);
  if (dryRun.code !== 0) ui.abort("dry-run", dryRun);
  ui.report("dry-run", dryRun);

  ui.begin("sync", LABELS.sync);
  const sync = await run("sync", []);
  if (sync.code !== 0) ui.abort("sync", sync);
  ui.report("sync", sync);

  ui.begin("idempotency", LABELS.idempotency);
  const idempotency = await run("idempotency", []);
  ui.reportIdempotency(idempotency, isUpToDate(idempotency.stdout));
}
