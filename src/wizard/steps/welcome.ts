import * as p from "@clack/prompts";
import pc from "picocolors";

const DIAGRAM = `
  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
  │ Notion Skills│ ───▶ │ Skills repo  │ ───▶ │  Cowork      │
  │ DB (source)  │      │ (plugins)    │      │  (agents)    │
  └──────────────┘      └──────────────┘      └──────────────┘
`;

export async function stepWelcome(): Promise<boolean> {
  p.intro(pc.bold("Notion Skills → GitHub Sync Setup"));

  p.note(DIAGRAM, "How it works");

  p.log.info(
    `You're setting up a sync script that connects Notion to Claude Cowork.\n\n` +
      `Your whole team gets a shared place to write and edit skills in Notion. ` +
      `This script syncs those skills on a schedule so they automatically appear in Cowork for everyone.\n\n` +
      `This takes about ${pc.bold("10 minutes")}: a few questions up front, one pause midway ` +
      `to create two access tokens, and the rest runs on its own. You'll need Notion and ` +
      `GitHub admin access — your team members won't; they just see skills show up in Cowork.`,
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
