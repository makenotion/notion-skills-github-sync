import { loggedExec } from "./exec.ts";
import type { WizardLogger } from "./logger.ts";
import { desiredExtraProperties } from "../notion/skill-schema.ts";

/**
 * Shared Notion Skills DB creation: schema + sample skills.
 * Used by both the interactive wizard (resources phase), the non-interactive
 * `--ci` runner, and the `migrate` command so the flows can't drift apart.
 */

export const SKILLS_DB_DEFAULT_NAME = "Skills";

const NOTION_VERSION = "2025-09-03";
// Typed database creation (`database_type: skills`) goes through the tools/run
// endpoint, which requires a newer API version than the rest of our calls.
const TOOLS_RUN_NOTION_VERSION = "2026-03-11";

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
 * Parse the Markdown that `tools/run create_database` returns. Unlike
 * `POST /v1/databases`, the typed-creation endpoint answers with prose; the
 * database url appears as `{{https://.../p/<32-hex-id>}}` (host varies by env)
 * and the data source as `{{collection://<uuid>}}`.
 */
export function parseTypedDbCreation(
  result: string,
): { databaseId: string; databaseUrl: string; dataSourceId: string } | null {
  const urlMatch = result.match(/\{\{(https?:\/\/[^}]*?([0-9a-f]{32}))\}\}/);
  const dsMatch = result.match(/\{\{collection:\/\/([0-9a-f-]{36})\}\}/);
  if (!urlMatch || !dsMatch) return null;
  const raw = urlMatch[2]!;
  const databaseId = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  return { databaseId, databaseUrl: urlMatch[1]!, dataSourceId: dsMatch[1]! };
}

/**
 * Create a typed skills database (`database_type: skills`) with only the
 * canonical schema (Skill name / Description / Files / Created by).
 * Parent defaults to the workspace top level; pass parentPageId to nest it.
 */
export async function createTypedSkillsDb(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  opts: { dbName: string; parentPageId?: string },
): Promise<CreateSkillsDbResult> {
  const createDatabase: Record<string, unknown> = {
    database_type: "skills",
    title: opts.dbName,
  };
  if (opts.parentPageId) {
    createDatabase.parent = { type: "page_id", page_id: opts.parentPageId };
  }

  const createResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "POST", "/v1/tools/run",
    "--notion-version", TOOLS_RUN_NOTION_VERSION,
  ], {
    stdin: JSON.stringify({ type: "create_database", create_database: createDatabase }),
  });

  if (createResult.code !== 0) {
    return { ok: false, error: createResult.stderr || createResult.stdout };
  }

  let parsed: ReturnType<typeof parseTypedDbCreation>;
  try {
    const response = JSON.parse(createResult.stdout) as { result?: string };
    parsed = parseTypedDbCreation(response.result ?? "");
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      ok: false,
      error: `Could not parse the typed-database-creation response: ${createResult.stdout.slice(0, 300)}`,
    };
  }

  // The Markdown is parsed by regex — confirm the ids against the structured
  // database object before building on them.
  const getResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "GET", `/v1/databases/${parsed.databaseId}`,
    "--notion-version", NOTION_VERSION,
  ]);
  if (getResult.code !== 0) {
    return {
      ok: false,
      error: `Typed database created but could not be read back: ${getResult.stderr || getResult.stdout}`,
    };
  }
  try {
    const db = JSON.parse(getResult.stdout);
    return {
      ok: true,
      db: {
        databaseId: db.id ?? parsed.databaseId,
        databaseUrl: db.url || parsed.databaseUrl,
        dataSourceId: db.data_sources?.[0]?.id ?? parsed.dataSourceId,
      },
    };
  } catch {
    return { ok: true, db: parsed };
  }
}

/** Add properties to a data source (one PATCH). Used for the sync's extras. */
export async function addDataSourceProperties(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  dataSourceId: string,
  properties: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const patchResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "PATCH", `/v1/data_sources/${dataSourceId}`,
    "--notion-version", NOTION_VERSION,
  ], { stdin: JSON.stringify({ properties }) });
  if (patchResult.code !== 0) {
    return { ok: false, error: patchResult.stderr || patchResult.stdout };
  }
  return { ok: true };
}

/**
 * Create the Notion Skills DB the sync expects: a typed skills database plus
 * the sync's extra properties (Published checkbox + Plugins select).
 */
export async function createSkillsDb(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  opts: { dbName: string; parentPageId?: string },
): Promise<CreateSkillsDbResult> {
  const created = await createTypedSkillsDb(logger, step, notionEnv, opts);
  if (!created.ok) return created;

  const extras = await addDataSourceProperties(
    logger,
    step,
    notionEnv,
    created.db.dataSourceId,
    desiredExtraProperties(),
  );
  if (!extras.ok) {
    return { ok: false, error: `Could not add the sync's extra properties: ${extras.error}` };
  }
  return created;
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
