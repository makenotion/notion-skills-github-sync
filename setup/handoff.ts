import * as p from "@clack/prompts";
import pc from "picocolors";
import type { SetupLogger } from "./logger.ts";

// Hard-stop the setup after a real failure: say exactly where it broke, hand
// the user a ready-to-paste prompt for a coding agent, and exit. Never let a
// failure fall through to later steps or the "all set!" wrapup — a skipped
// step is fine to continue past, a failed one is not.
export function abortWithHandoff(
  logger: SetupLogger,
  opts: {
    step: string; // human-readable, e.g. "push sync repo to GitHub"
    what: string; // one/two sentences: what went wrong
    detail?: string; // raw stderr or extra context, shown dimmed
  },
): never {
  logger.event("setup-aborted", { step: opts.step, what: opts.what });
  const logPath = logger.finalize();

  p.log.error(
    `${pc.bold(`Setup failed at: ${opts.step}`)}\n` +
      opts.what +
      (opts.detail ? `\n${pc.dim(opts.detail.trim())}` : ""),
  );

  p.log.message(
    `To investigate, paste this prompt into a coding agent (e.g. ${pc.cyan("claude")}) started in this directory:`,
  );

  // Plain console.log, outside clack's gutter, so it copies cleanly.
  console.log(
    "\n" +
      pc.cyan(
        `My \`bun run setup\` for notion-skills-github-sync failed at the "${opts.step}" step: ` +
          `${opts.what.replace(/\s*\n\s*/g, " ")} ` +
          `Read the setup log at ${logPath} — it's JSONL, one command/event record per line ` +
          `(secrets redacted) — to find the failing command and its stderr, and look at the ` +
          `relevant code in setup/steps/. Diagnose the root cause, fix it or give me the ` +
          `exact commands to run, then tell me to re-run \`bun run setup\`.`,
      ) +
      "\n",
  );

  p.outro(pc.dim(`Setup log: ${logPath}`));
  process.exit(1);
}
