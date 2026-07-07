import * as p from "@clack/prompts";
import pc from "picocolors";
import { loggedExec, commandExists } from "../exec.ts";
import type { WizardLogger } from "../logger.ts";

const SAMPLE_SKILLS = [
  {
    name: "Meeting Notes",
    description:
      "Helps structure and summarize meeting notes, capturing key decisions, action items, and follow-ups.",
    body: `# Meeting Notes

Help the user create structured, actionable meeting notes.

## When to use
After any meeting, standup, or call where decisions were made or action items assigned.

## What to capture
- **Attendees** — who was there
- **Key decisions** — what was agreed on
- **Action items** — who does what, by when
- **Open questions** — what needs follow-up
- **Next steps** — when to reconvene

## Style
Keep it scannable. Use bullet points over paragraphs. Bold the owner of each action item. Date everything.`,
  },
  {
    name: "Document Review",
    description:
      "Reviews documents for clarity, completeness, and consistency. Suggests improvements and flags potential issues.",
    body: `# Document Review

Review a document and provide structured feedback on clarity, completeness, and consistency.

## Approach
1. Read the full document before commenting.
2. Flag issues by severity: critical (blocks understanding), moderate (causes confusion), minor (polish).
3. Suggest specific rewrites rather than vague "make this clearer" feedback.

## Check for
- **Clarity** — can a new reader follow this without prior context?
- **Completeness** — are there gaps in reasoning or missing sections?
- **Consistency** — do terms, tone, and formatting stay uniform?
- **Actionability** — does the reader know what to do next?`,
  },
  {
    name: "Research Summary",
    description:
      "Synthesizes research from multiple sources into clear, actionable summaries with key takeaways.",
    body: `# Research Summary

Synthesize information from multiple sources into a concise, decision-ready summary.

## Structure
1. **Executive summary** — 2-3 sentences, the "so what"
2. **Key findings** — bulleted, ranked by importance
3. **Implications** — what this means for the team/project
4. **Recommendations** — concrete next steps
5. **Sources** — where the information came from

## Principles
- Lead with conclusions, not methodology.
- Quantify where possible ("3x increase" not "significant increase").
- Flag confidence level: confirmed, likely, speculative.
- Keep it under one page unless explicitly asked for depth.`,
  },
  {
    name: "Email Drafting",
    description:
      "Helps compose professional emails with appropriate tone, structure, and call-to-action.",
    body: `# Email Drafting

Help compose clear, professional emails that get results.

## Structure
- **Subject line** — specific, action-oriented (not "Quick question")
- **Opening** — context in one sentence (why you're writing)
- **Body** — the ask or information, broken into short paragraphs
- **Close** — clear next step and timeline

## Tone guidelines
- Match formality to the relationship and context.
- Default to warm-professional: friendly but focused.
- For escalations: direct, factual, no blame language.
- For asks: make it easy to say yes (provide options, context, deadlines).

## Length
Shorter is almost always better. If it takes more than 3 paragraphs, consider whether a meeting or doc would be more effective.`,
  },
  {
    name: "Project Planning",
    description:
      "Breaks down projects into phases, milestones, and tasks. Identifies dependencies and potential risks.",
    body: `# Project Planning

Break down a project into an actionable plan with clear milestones.

## Framework
1. **Goal** — one sentence describing success
2. **Phases** — 2-4 major stages of work
3. **Milestones** — concrete checkpoints (deliverables, not dates)
4. **Tasks** — specific work items under each phase
5. **Dependencies** — what blocks what
6. **Risks** — what could go wrong and mitigation strategies

## Principles
- Start from the desired outcome, work backwards.
- Every task should have a clear "done" state.
- Flag dependencies early — they're where projects stall.
- Build in buffer for unknowns (rule of thumb: 1.5x your estimate).
- Identify the critical path: the longest chain of dependent tasks.`,
  },
];

export interface NotionDbResult {
  dataSourceId: string;
  databaseId: string;
  databaseUrl: string;
}

export async function stepCreateNotionDb(
  logger: WizardLogger,
): Promise<NotionDbResult | null> {
  p.log.step(pc.bold("Step 2: Create the Notion skills database"));

  p.log.info(
    `We'll create a Notion database where your team writes and manages skills.\n` +
      `First, let's make sure the Notion CLI is installed and authenticated.`,
  );

  // Check if ntn is installed
  const hasNtn = await commandExists("ntn");
  if (!hasNtn) {
    const installSpinner = p.spinner();
    installSpinner.start("Installing the Notion CLI (ntn)...");
    const installResult = await loggedExec(
      logger,
      "notion-db",
      "bash",
      ["-c", "curl -fsSL https://ntn.dev | bash"],
    );
    if (installResult.code !== 0) {
      installSpinner.stop("Failed to install ntn CLI.");
      p.log.error(
        `Could not install the Notion CLI.\n${pc.dim(installResult.stderr)}`,
      );
      p.log.info(
        `Try installing manually: ${pc.cyan("curl -fsSL https://ntn.dev | bash")}`,
      );
      return null;
    }
    installSpinner.stop("Notion CLI installed.");
  } else {
    p.log.success("Notion CLI (ntn) is already installed.");
  }

  // Check if ntn is authenticated
  const authCheck = await loggedExec(logger, "notion-db", "ntn", [
    "--env",
    "dev",
    "whoami",
  ]);
  if (authCheck.code !== 0) {
    p.log.warn(
      `The Notion CLI needs to be authenticated. Let's log in now.`,
    );
    p.log.info(
      `A browser window will open for Notion authentication.\n` +
        `${pc.dim("If you're in a terminal without browser access, you'll need to set NOTION_API_TOKEN instead.")}`,
    );

    const doLogin = await p.confirm({
      message: "Open browser to authenticate with Notion?",
      initialValue: true,
    });

    if (p.isCancel(doLogin) || !doLogin) {
      p.log.info(
        `You can authenticate later with: ${pc.cyan("ntn --env dev login")}`,
      );
      return null;
    }

    const loginResult = await loggedExec(logger, "notion-db", "ntn", [
      "--env",
      "dev",
      "login",
    ]);
    if (loginResult.code !== 0) {
      p.log.error(`Authentication failed. ${pc.dim(loginResult.stderr)}`);
      return null;
    }
    p.log.success("Authenticated with Notion.");
  } else {
    p.log.success(`Authenticated with Notion as ${pc.cyan(authCheck.stdout.trim())}.`);
  }

  // Create the database
  const dbName = await p.text({
    message: "What should we name the skills database?",
    placeholder: "Cowork Skills",
    defaultValue: "Cowork Skills",
    validate: (v) => (!v || v.trim().length === 0 ? "Name cannot be empty" : undefined),
  });

  if (p.isCancel(dbName)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  const createSpinner = p.spinner();
  createSpinner.start("Creating the skills database in Notion...");

  // Create database at workspace level using /v1/databases (API version 2025-09-03+)
  const createResult = await loggedExec(logger, "notion-db", "ntn", [
    "--env",
    "dev",
    "api",
    "-X",
    "POST",
    "/v1/databases",
    "--notion-version",
    "2025-09-03",
  ], {
    stdin: JSON.stringify({
      parent: { type: "workspace", workspace: true },
      title: [{ text: { content: String(dbName) } }],
      properties: {},
    }),
  });

  if (createResult.code !== 0) {
    createSpinner.stop("Failed to create database.");
    p.log.error(
      `Could not create the database.\n${pc.dim(createResult.stderr || createResult.stdout)}`,
    );
    return null;
  }

  let dsId: string;
  let dbId: string;
  let dbUrl: string;
  try {
    const response = JSON.parse(createResult.stdout);
    dbId = response.id;
    dbUrl = response.url || `https://notion.so/${dbId.replace(/-/g, "")}`;
    const ds = response.data_sources?.[0];
    dsId = ds?.id || dbId;
  } catch {
    createSpinner.stop("Database created, but could not parse response.");
    p.log.warn(
      `Created the database but couldn't parse the response. ` +
        `You may need to find the database ID manually in Notion.`,
    );
    p.log.message(pc.dim(createResult.stdout.slice(0, 500)));

    const manualDsId = await p.text({
      message: "Enter the data source ID (from the response above):",
    });
    if (p.isCancel(manualDsId) || !manualDsId) return null;
    dsId = String(manualDsId).trim();
    dbId = dsId;
    dbUrl = `https://notion.so/${dbId.replace(/-/g, "")}`;
  }

  // Add schema properties via data source PATCH (rename default "Name" to "Skill name" + add others)
  await loggedExec(logger, "notion-db", "ntn", [
    "--env", "dev", "api", "-X", "PATCH",
    `/v1/data_sources/${dsId}`, "--notion-version", "2025-09-03",
  ], { stdin: JSON.stringify({ properties: { Name: { name: "Skill name" } } }) });

  await loggedExec(logger, "notion-db", "ntn", [
    "--env", "dev", "api", "-X", "PATCH",
    `/v1/data_sources/${dsId}`, "--notion-version", "2025-09-03",
  ], {
    stdin: JSON.stringify({
      properties: {
        Description: { rich_text: {} },
        "Created by": { created_by: {} },
        Published: { checkbox: {} },
        Plugins: {
          select: {
            options: [
              { name: "writing-assistant" },
              { name: "research-tools" },
              { name: "productivity" },
            ],
          },
        },
      },
    }),
  });

  createSpinner.stop("Skills database created!");
  p.log.success(`Database: ${pc.cyan(dbUrl)}`);

  // Populate with sample skills
  const populateSpinner = p.spinner();
  populateSpinner.start("Adding sample skills to the database...");

  let populated = 0;
  for (const skill of SAMPLE_SKILLS) {
    const pageResult = await loggedExec(logger, "notion-db", "ntn", [
      "--env",
      "dev",
      "api",
      "-X",
      "POST",
      "/v1/pages",
      "--notion-version",
      "2025-09-03",
    ], {
      stdin: JSON.stringify({
        parent: { data_source_id: dsId },
        properties: {
          "Skill name": { title: [{ text: { content: skill.name } }] },
          Description: {
            rich_text: [{ text: { content: skill.description } }],
          },
          Published: { checkbox: true },
        },
        children: skill.body.split("\n").map((line) => ({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: line } }],
          },
        })),
      }),
    });
    if (pageResult.code === 0) populated++;
  }

  populateSpinner.stop(
    `Added ${populated}/${SAMPLE_SKILLS.length} sample skills.`,
  );

  if (populated < SAMPLE_SKILLS.length) {
    p.log.warn(
      `Some sample skills failed to create. You can add more manually later.`,
    );
  }

  p.log.success(
    `Your skills database is ready at ${pc.cyan(dbUrl)}\n` +
      `${pc.dim("Team members can browse and add skills there.")}`,
  );

  return { dataSourceId: dsId, databaseId: dbId, databaseUrl: dbUrl };
}
