import * as p from "@clack/prompts";
import pc from "picocolors";
import { openInBrowser } from "../exec.ts";
import {
  claudeGithubAppHelp,
  claudeMarketplaceRegistrationHelp,
} from "../guidance.ts";
import type { SetupLogger } from "../logger.ts";

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

  // Rendered from the shared guidance builder: the steps are intent-level and
  // point at Claude's own guide, so this survives Claude's frequent (A/B-tested)
  // plugin-UI churn instead of encoding a walkthrough that goes stale in weeks.
  p.log.message(
    pc.bold("Register the marketplace in Claude (as an org admin):\n") +
      claudeMarketplaceRegistrationHelp(input.skillsRepo),
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
      `Team members just write skills in Notion — there's no checkbox to tick.\n` +
      `The sync picks them up within the hour, and they appear in Cowork for\n` +
      `everyone. What syncs is whatever the Notion connection can read, so scope\n` +
      `the connection to control what gets published.\n\n` +
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
