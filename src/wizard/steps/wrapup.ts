import * as p from "@clack/prompts";
import pc from "picocolors";

interface WrapupInput {
  databaseUrl: string;
  repoUrl: string;
  testSyncPassed: boolean;
  logPath: string;
}

export async function stepWrapup(input: WrapupInput): Promise<void> {
  p.log.step(pc.bold("Step 6: You're all set!"));

  const status = input.testSyncPassed
    ? pc.green("Everything is working.")
    : pc.yellow("Setup complete — test sync pending.");

  p.note(
    `${status}\n\n` +
      `${pc.bold("Your skills database:")} ${input.databaseUrl}\n` +
      `${pc.bold("Your GitHub repo:")}     ${input.repoUrl}\n\n` +
      `${pc.dim("The sync runs hourly via GitHub Actions.")}\n` +
      `${pc.dim("Skills published in Notion automatically appear in Cowork.")}`,
    "Summary",
  );

  p.log.message(
    pc.bold("What happens next:\n") +
      `  • Team members add skills in Notion — just write a page and check "Published"\n` +
      `  • The sync picks them up within the hour\n` +
      `  • Skills appear in Cowork for everyone in your org\n`,
  );

  p.log.message(
    pc.bold("Useful commands:\n") +
      `  ${pc.cyan("bun run sync")}        Run a manual sync\n` +
      `  ${pc.cyan("bun run dry-run")}     Preview changes without pushing\n` +
      `  ${pc.cyan("bun run setup")}       Re-run Notion database setup\n`,
  );

  p.log.message(
    pc.dim(`Setup log saved to: ${input.logPath}\n`) +
      pc.dim(`This log can be used to diagnose issues or hand off to a coding agent.`),
  );

  p.outro(
    pc.bold("Happy syncing!") +
      pc.dim(" Your team's knowledge now flows from Notion → Cowork automatically."),
  );
}
