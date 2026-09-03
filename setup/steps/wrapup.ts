import * as p from "@clack/prompts";
import pc from "picocolors";
import { openInBrowser } from "../exec.ts";
import type { SetupLogger } from "../logger.ts";

const CLAUDE_PLUGINS_GUIDE =
  "https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization#h_ae90e57fb6";
const CHATGPT_CODEX_PLUGINS_GUIDE =
  "https://help.openai.com/en/articles/20001504-importing-and-syncing-plugin-marketplaces-from-github";

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
  p.log.step(pc.bold("Step 6 of 6: Connect to agent apps (optional)"));

  p.log.info(
    `The sync is live! Your GitHub repo now contains your skills.`,
  );

  const connectApps = await p.confirm({
    message: "Would you like to sync your GitHub repo to an agent app now?",
    initialValue: true,
  });
  logger.event("agent-app-connect-confirm", {
    cancelled: p.isCancel(connectApps),
    value: p.isCancel(connectApps) ? null : connectApps,
  });
  if (!p.isCancel(connectApps) && connectApps) {
    const apps = await p.multiselect({
      message: "Which agent apps would you like to connect?",
      options: [
        { value: "claude", label: "Claude" },
        { value: "chatgpt-codex", label: "ChatGPT/Codex" },
      ],
      required: false,
    });
    if (!p.isCancel(apps)) {
      logger.event("agent-apps-selected", { apps });
      if (apps.includes("claude")) {
        p.log.message(
          `${pc.bold("Claude")}\n` +
            `Follow the GitHub marketplace instructions: ${pc.cyan(CLAUDE_PLUGINS_GUIDE)}`,
        );
      }
      if (apps.includes("chatgpt-codex")) {
        p.log.message(
          `${pc.bold("ChatGPT/Codex")}\n` +
            `Follow the GitHub marketplace instructions: ${pc.cyan(CHATGPT_CODEX_PLUGINS_GUIDE)}`,
        );
      }
    }
  } else if (!p.isCancel(connectApps)) {
    p.log.info(
      "No problem — you can connect this GitHub repo to an agent app anytime.",
    );
  }

  p.note(
    `${pc.bold("Notion Skills DB:")}   ${input.databaseUrl}\n` +
      `${pc.bold("Skills repo:")}       ${input.skillsRepoUrl}\n` +
      `${pc.bold("Sync script repo:")}  https://github.com/${input.syncRepo}\n\n` +
      `Team members just write skills in Notion — there's no checkbox to tick.\n` +
      `The sync picks them up within the hour and publishes them to GitHub.\n` +
      `What syncs is whatever the Notion connection can read, so scope the\n` +
      `connection to control what gets published.\n\n` +
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
      pc.dim(" Your team's knowledge now flows from Notion → GitHub automatically."),
  );
}
