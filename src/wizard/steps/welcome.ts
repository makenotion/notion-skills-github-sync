import * as p from "@clack/prompts";
import pc from "picocolors";

const orange = (s: string) => `\x1b[38;5;208m${s}\x1b[0m`;

const DIAGRAM = `
  ${pc.cyan("┌──────────────┐")}      ${pc.green("┌──────────────┐")}      ${orange("┌──────────────┐")}
  ${pc.cyan("│  Notion DB   │")} ───▶ ${pc.green("│  GitHub Repo │")} ───▶ ${orange("│  Cowork      │")}
  ${pc.cyan("│  (Skills)    │")}      ${pc.green("│  (Plugins)   │")}      ${orange("│  (Agents)    │")}
  ${pc.cyan("└──────────────┘")}      ${pc.green("└──────────────┘")}      ${orange("└──────────────┘")}
`;

export async function stepWelcome(): Promise<boolean> {
  p.intro(pc.bold("Notion Skills → GitHub Sync Setup"));

  p.note(DIAGRAM, "How it works");

  p.log.info(
    `You're setting up a sync script that connects ${pc.cyan("Notion")} to ${orange("Claude Cowork")}.\n\n` +
      `Your whole team gets a shared place to write and edit skills in Notion. ` +
      `This script syncs those skills on a schedule so they automatically appear in Cowork for everyone.\n\n` +
      `${pc.bold("The update flow:")} Edit a skill in Notion → the sync runs hourly via GitHub Actions → ` +
      `updated skill shows up in Cowork. No redeploy needed.\n\n` +
      `This takes about ${pc.bold("20 minutes")}. You'll need Notion and GitHub admin access — ` +
      `we'll walk you through those parts. Your team members won't need GitHub; ` +
      `they just see skills show up in Cowork.`,
  );

  const proceed = await p.confirm({
    message: "Ready to begin?",
    initialValue: true,
  });

  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Setup cancelled. Run this command again when you're ready.");
    return false;
  }

  return true;
}
