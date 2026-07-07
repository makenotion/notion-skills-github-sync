import * as p from "@clack/prompts";
import pc from "picocolors";

const DIAGRAM = `
  ${pc.cyan("┌──────────────┐")}      ${pc.green("┌──────────────┐")}      ${pc.magenta("┌──────────────┐")}
  ${pc.cyan("│  Notion DB   │")} ───▶ ${pc.green("│  GitHub Repo │")} ───▶ ${pc.magenta("│  Co-Work     │")}
  ${pc.cyan("│  (Skills)    │")}      ${pc.green("│  (Plugins)   │")}      ${pc.magenta("│  (Agents)    │")}
  ${pc.cyan("└──────────────┘")}      ${pc.green("└──────────────┘")}      ${pc.magenta("└──────────────┘")}
`;

export async function stepWelcome(): Promise<boolean> {
  p.intro(pc.bold("Notion Skills → GitHub Sync Setup"));

  p.note(DIAGRAM, "How it works");

  p.log.info(
    `You're setting up a sync script that connects ${pc.cyan("Notion")} to ${pc.magenta("Claude Co-Work")}.\n\n` +
      `Here's what happens:\n` +
      `  1. We create a ${pc.cyan("Notion skills database")} for your team.\n` +
      `  2. A sync script runs on a schedule, converting skills into plugins.\n` +
      `  3. Your team writes & edits skills in Notion — they appear in Co-Work automatically.\n\n` +
      `${pc.dim("You own the code and the deploy. Team members just see skills show up in Co-Work — no GitHub needed.")}`,
  );

  const faqChoice = await p.select({
    message: "Have a question before we start?",
    options: [
      { value: "start", label: "Let's go!" },
      { value: "time", label: "How long will this take?" },
      { value: "need", label: "What will I need?" },
      { value: "org", label: "Does everyone in my org need GitHub?" },
    ],
  });

  if (p.isCancel(faqChoice)) {
    p.cancel("Setup cancelled.");
    return false;
  }

  if (faqChoice === "time") {
    p.log.info(
      `${pc.bold("~20 minutes.")} We'll walk you through each step — Notion database creation, ` +
        `GitHub repo setup, and deploying the sync via GitHub Actions.`,
    );
  } else if (faqChoice === "need") {
    p.log.info(
      `${pc.bold("Notion admin access")} — to create a database and integration.\n` +
        `${pc.bold("GitHub access")} — to create a repo and add secrets.\n\n` +
        `We'll walk you through each part when we get there.`,
    );
  } else if (faqChoice === "org") {
    p.log.info(
      `${pc.bold("No.")} GitHub is an implementation detail. Your team members only interact with ` +
        `Notion — they write and edit skills there. The sync script handles the rest behind the scenes.`,
    );
  }

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
