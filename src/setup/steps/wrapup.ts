import * as p from "@clack/prompts";
import pc from "picocolors";
import { openInBrowser } from "../exec.ts";
import { claudeGithubAppHelp } from "../guidance.ts";
import type { SetupLogger } from "../logger.ts";

const CLAUDE_PLUGINS_GUIDE =
  "https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization";

interface WrapupInput {
  dbName: string;
  databaseUrl: string;
  skillsRepo: string; // owner/name
  skillsRepoUrl: string;
  syncRepo: string; // owner/name
  logPath: string;
}

export async function stepWrapup(
  logger: SetupLogger,
  input: WrapupInput,
): Promise<void> {
  p.log.step(pc.bold("Step 6 of 6: Connect the marketplace to Claude"));

  p.log.info(
    `The sync is live — one last thing: register your new marketplace in Claude\n` +
      `so the skills reach your team.`,
  );

  p.log.message(
    pc.bold("In Claude (as an org admin):\n") +
      `  1. Go to ${pc.bold("Organization settings → Plugins")}\n` +
      `  2. Click ${pc.bold("Add plugin")} and choose ${pc.bold("GitHub")} as the source\n` +
      `  3. Enter your skills repo: ${pc.cyan(input.skillsRepo)}\n` +
      `  4. Verify access with your GitHub account — Claude then syncs the plugins\n` +
      `  5. Optional: open the marketplace's ${pc.bold("···")} menu and turn on ${pc.bold("Sync automatically")}\n` +
      `  6. Set each plugin's distribution: installed by default, available, required, or hidden\n\n` +
      pc.dim(
        `Requires a Team or Enterprise plan, an Owner role, and Cowork + Skills enabled.\n`,
      ) +
      `  Full guide: ${pc.cyan(CLAUDE_PLUGINS_GUIDE)}`,
  );

  // The private skills repo often won't show up in Claude's picker unless the
  // org's Claude GitHub app is granted access to it — the last thing to bite.
  p.log.message(pc.dim(claudeGithubAppHelp(input.skillsRepo)));

  const registered = await p.confirm({
    message: "Done registering the marketplace in Claude?",
    initialValue: true,
  });
  logger.event("marketplace-registered-confirm", {
    cancelled: p.isCancel(registered),
    value: p.isCancel(registered) ? null : registered,
  });
  if (!p.isCancel(registered) && !registered) {
    p.log.info(
      `No problem — do it anytime; the guide is linked above. The sync keeps\n` +
        `running either way.`,
    );
  }

  p.note(
    `${pc.bold("Notion Skills DB:")}   ${input.databaseUrl}\n` +
      `${pc.bold("Skills repo:")}       ${input.skillsRepoUrl}\n` +
      `${pc.bold("Sync script repo:")}  https://github.com/${input.syncRepo}\n\n` +
      `Team members write skills in Notion and check "Published" — the sync\n` +
      `picks them up within the hour, and they appear in Cowork for everyone.\n\n` +
      pc.dim(`Setup log: ${input.logPath}`),
    "You're all set",
  );

  const openDb = await p.confirm({
    message: `Open your Notion Skills DB in the browser? (${input.databaseUrl})`,
    initialValue: true,
  });
  if (!p.isCancel(openDb) && openDb) {
    await openInBrowser(logger, "wrapup", input.databaseUrl);
  }

  p.outro(
    pc.bold("Happy syncing!") +
      pc.dim(" Your team's knowledge now flows from Notion → Cowork automatically."),
  );
}
