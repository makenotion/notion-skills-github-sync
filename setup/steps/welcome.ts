import * as p from "@clack/prompts";
import pc from "picocolors";

const DIAGRAM = `
  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
  │ Notion Skills│ ───▶ │ GitHub repo  │ ───▶ │  Agent app   │
  │ DB           │      │              │      │              │
  └──────────────┘      └──────────────┘      └──────────────┘
`;

export async function stepWelcome(): Promise<boolean> {
  p.intro(pc.bold("Notion Skills → GitHub Sync"));

  p.note(DIAGRAM, "How it works");

  p.log.info(
    `You're setting up a script that syncs agent skills from Notion to a GitHub repo. ` +
      `From there, you can sync to your chosen agent apps.\n\n` +
      `This lets you store your skills in a collaborative library that's accessible to your ` +
      `whole team, not just engineers who know how to use GitHub.\n\n` +
      `To complete setup, you'll need access to create authentication tokens in Notion and GitHub.`,
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
