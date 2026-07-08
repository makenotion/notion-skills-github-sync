import { loggedExec } from "./exec.ts";
import type { WizardLogger } from "./logger.ts";

/**
 * Shared Notion Skills DB creation: schema + sample skills.
 * Used by both the interactive wizard (resources phase) and the
 * non-interactive `--ci` runner so the two flows can't drift apart.
 */

export const SKILLS_DB_DEFAULT_NAME = "Skills";

const NOTION_VERSION = "2025-09-03";

interface SampleSkill {
  name: string;
  description: string;
  plugin: string;
  body: string;
}

const SAMPLE_SKILLS: SampleSkill[] = [
  {
    name: "Meeting Notes",
    description:
      "Helps structure and summarize meeting notes, capturing key decisions, action items, and follow-ups.",
    plugin: "productivity",
    body: `# Meeting Notes

Help the user create structured, actionable meeting notes.

## When to use
After any meeting, standup, or call where decisions were made or action items assigned.

## What to capture
- Attendees — who was there
- Key decisions — what was agreed on
- Action items — who does what, by when
- Open questions — what needs follow-up
- Next steps — when to reconvene

## Style
Keep it scannable. Use bullet points over paragraphs. Bold the owner of each action item. Date everything.`,
  },
  {
    name: "Document Review",
    description:
      "Reviews documents for clarity, completeness, and consistency. Suggests improvements and flags potential issues.",
    plugin: "writing-assistant",
    body: `# Document Review

Review a document and provide structured feedback on clarity, completeness, and consistency.

## Approach
1. Read the full document before commenting.
2. Flag issues by severity: critical (blocks understanding), moderate (causes confusion), minor (polish).
3. Suggest specific rewrites rather than vague "make this clearer" feedback.

## Check for
- Clarity — can a new reader follow this without prior context?
- Completeness — are there gaps in reasoning or missing sections?
- Consistency — do terms, tone, and formatting stay uniform?
- Actionability — does the reader know what to do next?`,
  },
  {
    name: "Research Summary",
    description:
      "Synthesizes research from multiple sources into clear, actionable summaries with key takeaways.",
    plugin: "research-tools",
    body: `# Research Summary

Synthesize information from multiple sources into a concise, decision-ready summary.

## Structure
1. Executive summary — 2-3 sentences, the "so what"
2. Key findings — bulleted, ranked by importance
3. Implications — what this means for the team/project
4. Recommendations — concrete next steps
5. Sources — where the information came from

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
    plugin: "writing-assistant",
    body: `# Email Drafting

Help compose clear, professional emails that get results.

## Structure
- Subject line — specific, action-oriented (not "Quick question")
- Opening — context in one sentence (why you're writing)
- Body — the ask or information, broken into short paragraphs
- Close — clear next step and timeline

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
    plugin: "productivity",
    body: `# Project Planning

Break down a project into an actionable plan with clear milestones.

## Framework
1. Goal — one sentence describing success
2. Phases — 2-4 major stages of work
3. Milestones — concrete checkpoints (deliverables, not dates)
4. Tasks — specific work items under each phase
5. Dependencies — what blocks what
6. Risks — what could go wrong and mitigation strategies

## Principles
- Start from the desired outcome, work backwards.
- Every task should have a clear "done" state.
- Flag dependencies early — they're where projects stall.
- Identify the critical path: the longest chain of dependent tasks.`,
  },
];

/** Convert a markdown-lite skill body into Notion blocks (h1/h2, lists, paragraphs). */
export function bodyToBlocks(body: string): unknown[] {
  const blocks: unknown[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let type = "paragraph";
    let text = line;
    if (line.startsWith("# ")) {
      type = "heading_1";
      text = line.slice(2);
    } else if (line.startsWith("## ")) {
      type = "heading_2";
      text = line.slice(3);
    } else if (line.startsWith("- ")) {
      type = "bulleted_list_item";
      text = line.slice(2);
    } else if (/^\d+\.\s/.test(line)) {
      type = "numbered_list_item";
      text = line.replace(/^\d+\.\s/, "");
    }

    blocks.push({
      object: "block",
      type,
      [type]: { rich_text: [{ type: "text", text: { content: text } }] },
    });
  }
  return blocks;
}

export interface CreatedSkillsDb {
  dataSourceId: string;
  databaseId: string;
  databaseUrl: string;
}

export type CreateSkillsDbResult =
  | { ok: true; db: CreatedSkillsDb }
  | { ok: false; error: string };

/**
 * Create the Notion Skills DB with the sync's expected schema.
 * Parent defaults to the workspace top level; pass parentPageId to nest it.
 */
export async function createSkillsDb(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  opts: { dbName: string; parentPageId?: string },
): Promise<CreateSkillsDbResult> {
  const parent = opts.parentPageId
    ? { type: "page_id", page_id: opts.parentPageId }
    : { type: "workspace", workspace: true };

  const createResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "POST", "/v1/databases",
    "--notion-version", NOTION_VERSION,
  ], {
    stdin: JSON.stringify({
      parent,
      title: [{ text: { content: opts.dbName } }],
      properties: {},
    }),
  });

  if (createResult.code !== 0) {
    return { ok: false, error: createResult.stderr || createResult.stdout };
  }

  let dataSourceId: string;
  let databaseId: string;
  let databaseUrl: string;
  try {
    const response = JSON.parse(createResult.stdout);
    databaseId = response.id;
    databaseUrl =
      response.url || `https://notion.so/${databaseId.replace(/-/g, "")}`;
    dataSourceId = response.data_sources?.[0]?.id || databaseId;
  } catch {
    return {
      ok: false,
      error: `Could not parse the database-creation response: ${createResult.stdout.slice(0, 300)}`,
    };
  }

  // The DB starts with a default "Name" title property — rename it, then add
  // the rest of the schema. Both are data-source PATCHes.
  const renameResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "PATCH", `/v1/data_sources/${dataSourceId}`,
    "--notion-version", NOTION_VERSION,
  ], { stdin: JSON.stringify({ properties: { Name: { name: "Skill name" } } }) });
  if (renameResult.code !== 0) {
    return { ok: false, error: `Could not rename the title property: ${renameResult.stderr}` };
  }

  const patchResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "PATCH", `/v1/data_sources/${dataSourceId}`,
    "--notion-version", NOTION_VERSION,
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
  if (patchResult.code !== 0) {
    return { ok: false, error: `Could not add schema properties: ${patchResult.stderr || patchResult.stdout}` };
  }

  return { ok: true, db: { dataSourceId, databaseId, databaseUrl } };
}

/** Populate the DB with sample skills. Returns created/total counts. */
export async function populateSampleSkills(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  dataSourceId: string,
): Promise<{ created: number; total: number }> {
  let created = 0;
  for (const skill of SAMPLE_SKILLS) {
    const pageResult = await loggedExec(logger, step, "ntn", [
      "--env", notionEnv,
      "api", "-X", "POST", "/v1/pages",
      "--notion-version", NOTION_VERSION,
    ], {
      stdin: JSON.stringify({
        parent: { data_source_id: dataSourceId },
        properties: {
          "Skill name": { title: [{ text: { content: skill.name } }] },
          Description: {
            rich_text: [{ text: { content: skill.description } }],
          },
          Published: { checkbox: true },
          Plugins: { select: { name: skill.plugin } },
        },
        children: bodyToBlocks(skill.body),
      }),
    });
    if (pageResult.code === 0) created++;
  }
  return { created, total: SAMPLE_SKILLS.length };
}

/**
 * Probe whether `token` can read the given data source — used to poll for the
 * "connect the integration to the Notion Skills DB" manual step completing.
 */
export async function tokenCanReadDataSource(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  token: string,
  dataSourceId: string,
): Promise<boolean> {
  const result = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "GET", `/v1/data_sources/${dataSourceId}`,
    "--notion-version", NOTION_VERSION,
  ], { env: { NOTION_API_TOKEN: token } });
  return result.code === 0;
}
