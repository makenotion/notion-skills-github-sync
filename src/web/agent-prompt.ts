/**
 * Builds the copy-paste prompt for the visual setup app's "eject to coding
 * agent" escape hatch.
 *
 * Mirrors the intent of the CLI's `abortWithHandoff` prompt (src/wizard/
 * handoff.ts) but is a general "help me get unstuck" — it isn't tied to a
 * specific failed step. It embeds the diagnostic log (already redacted on
 * disk) so a coding agent has the full command/return-value/diagnostics
 * history to work from. Kept pure and standalone so it's unit-testable.
 */

const MAX_LOG_CHARS = 60_000;

export interface EjectPromptInput {
  /** Absolute path to the JSONL setup log. */
  logPath: string;
  /** The step the user was on when they ejected, if known (e.g. "credentials"). */
  currentStep?: string;
  /** The raw JSONL log contents to embed. Truncated if very large. */
  logContents?: string;
}

/** Trim an over-long log to its most recent lines, keeping the tail. */
export function truncateLog(contents: string, maxChars = MAX_LOG_CHARS): string {
  if (contents.length <= maxChars) return contents;
  const tail = contents.slice(contents.length - maxChars);
  // Drop the first (now-partial) line so the excerpt is valid JSONL throughout.
  const firstNewline = tail.indexOf("\n");
  const clean = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
  return `[… earlier log lines omitted …]\n${clean}`;
}

export function buildEjectPrompt(input: EjectPromptInput): string {
  const stepLine = input.currentStep
    ? ` I'm on the "${input.currentStep}" step.`
    : "";

  const log = input.logContents?.trim()
    ? truncateLog(input.logContents.trim())
    : "";

  const logSection = log
    ? `\n\nHere is my setup log — it's JSONL, one command/event record per line, ` +
      `secrets already redacted (also saved at ${input.logPath}):\n\n` +
      "```jsonl\n" +
      log +
      "\n```\n"
    : ` Read the setup log at ${input.logPath} — it's JSONL, one command/event ` +
      `record per line (secrets redacted).`;

  return (
    `I'm setting up notion-skills-github-sync with the visual web setup app and I'm stuck.` +
    stepLine +
    logSection +
    `\nPlease look at the setup code in src/web/ and src/wizard/ (especially the ` +
    `step logic and the commands the log shows), diagnose the root cause from the ` +
    `failing commands and their stderr, and either fix it or give me the exact ` +
    `commands to run to get unstuck.`
  );
}
