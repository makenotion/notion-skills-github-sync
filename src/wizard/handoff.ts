import pc from "picocolors";
import type { WizardIO } from "./io.ts";
import type { WizardLogger } from "./logger.ts";

export interface HandoffContext {
  /** Human-readable step, e.g. "push sync repo to GitHub" or "credentials". */
  step: string;
  /** One/two sentences: what went wrong, or what the user is stuck on. */
  what: string;
  /** Path to the JSONL setup log. */
  logPath: string;
}

/**
 * The single source of truth for the "paste this into a coding agent" prompt.
 * Used by both the CLI/web abort path (a real failure) and the web "eject"
 * escape hatch (available at any step). Pure string builder so it stays
 * testable and identical across surfaces.
 */
export function buildHandoffPrompt(ctx: HandoffContext): string {
  return (
    `My \`bun run setup\` for notion-skills-github-sync ${
      ctx.step ? `is at the "${ctx.step}" step: ` : "needs help: "
    }` +
    `${ctx.what.replace(/\s*\n\s*/g, " ")} ` +
    `Read the setup log at ${ctx.logPath} — it's JSONL, one command/event record per line ` +
    `(secrets redacted) — to find the relevant commands and their stderr, and look at the ` +
    `relevant code in src/wizard/steps/. Diagnose the root cause, fix it or give me the ` +
    `exact commands to run, then tell me to re-run \`bun run setup\`.`
  );
}

/**
 * Thrown by {@link abortWithHandoff} so a real failure unwinds the flow instead
 * of exiting the process directly. The CLI wrapper turns this into `exit(1)`;
 * the web server turns it into an error event — neither the deep step code nor
 * this module needs to know which surface it's on.
 */
export class SetupAbortError extends Error {
  constructor(
    public readonly context: HandoffContext,
    public readonly detail?: string,
  ) {
    super(`Setup aborted at: ${context.step}`);
    this.name = "SetupAbortError";
  }
}

/**
 * Hard-stop the setup after a real failure: say exactly where it broke, hand
 * the user a ready-to-paste prompt for a coding agent, and unwind. Never let a
 * failure fall through to later steps or the "all set!" wrapup — a skipped step
 * is fine to continue past, a failed one is not.
 */
export function abortWithHandoff(
  io: WizardIO,
  logger: WizardLogger,
  opts: {
    step: string;
    what: string;
    detail?: string;
  },
): never {
  logger.event("setup-aborted", { step: opts.step, what: opts.what });
  const logPath = logger.finalize();

  io.error(
    `${pc.bold(`Setup failed at: ${opts.step}`)}\n` +
      opts.what +
      (opts.detail ? `\n${pc.dim(opts.detail.trim())}` : ""),
  );

  io.message(
    `To investigate, paste this prompt into a coding agent (e.g. ${pc.cyan("claude")}) started in this directory:`,
  );
  io.handoff(
    pc.cyan(buildHandoffPrompt({ step: opts.step, what: opts.what, logPath })),
  );

  throw new SetupAbortError(
    { step: opts.step, what: opts.what, logPath },
    opts.detail,
  );
}
