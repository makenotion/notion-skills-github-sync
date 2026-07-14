import { loggedExec } from "./exec.ts";
import type { WizardLogger } from "./logger.ts";
import { desiredExtraProperties } from "../notion/skill-schema.ts";

/**
 * Shared Notion Skills DB creation: schema + sample skills.
 * Used by both the interactive wizard (resources phase) and the
 * non-interactive `--ci` runner so the two flows can't drift apart.
 */

export const SKILLS_DB_DEFAULT_NAME = "Skills";

const NOTION_VERSION = "2025-09-03";
// Typed-database creation goes through the tools API, which needs a newer
// Notion-Version than the rest of our REST calls.
const TYPED_NOTION_VERSION = "2026-03-11";

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
 * Parse the Markdown blob that `POST /v1/tools/run { create_database }` returns
 * (typed creation doesn't return structured JSON). We pull out the database url
 * (`.../p/<id>`) and the `collection://<data-source-id>`, both wrapped in
 * `{{ }}`. Returns null if either can't be found.
 */
export function parseCreateDatabaseResult(
  markdown: string,
): { databaseId: string; databaseUrl: string; dataSourceId: string } | null {
  const dbMatch = markdown.match(
    /<database\s+url="\{\{(https?:\/\/[^}"]+\/p\/([0-9a-fA-F-]{32,})[^}"]*)\}\}"/,
  );
  const dsMatch = markdown.match(
    /<data-source\s+url="\{\{collection:\/\/([0-9a-fA-F-]{32,})\}\}"/,
  );
  if (!dbMatch || !dsMatch) return null;
  return {
    databaseUrl: dbMatch[1]!,
    databaseId: dbMatch[2]!,
    dataSourceId: dsMatch[1]!,
  };
}

/**
 * Create a Notion **typed** skills DB (`database_type: skills`) and layer on the
 * sync's extra properties (`Published`, `Plugins`).
 *
 * Typed creation must be parented to a page — `tools/run` rejects a workspace
 * parent, and internal integrations can't create workspace-level databases
 * anyway. Pass `parentPageId`; when omitted we create a lightweight container
 * page at the workspace root first (works with user credentials that carry the
 * `insert_content` capability).
 */
export async function createSkillsDb(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  opts: { dbName: string; parentPageId?: string },
): Promise<CreateSkillsDbResult> {
  // 1. Resolve a parent page (typed creation can't target the workspace root).
  let parentPageId = opts.parentPageId;
  if (!parentPageId) {
    const containerResult = await loggedExec(logger, step, "ntn", [
      "--env", notionEnv,
      "api", "-X", "POST", "/v1/pages",
      "--notion-version", NOTION_VERSION,
    ], {
      stdin: JSON.stringify({
        parent: { type: "workspace", workspace: true },
        properties: { title: [{ text: { content: opts.dbName } }] },
      }),
    });
    if (containerResult.code !== 0) {
      return {
        ok: false,
        error:
          "Typed skills databases must be created under a page, but no parent " +
          "page was given and creating a workspace-level container page failed " +
          `(${(containerResult.stderr || containerResult.stdout).trim()}). ` +
          "Re-run with a parent page (e.g. --db-parent-page <id>).",
      };
    }
    try {
      parentPageId = JSON.parse(containerResult.stdout).id as string;
    } catch {
      return {
        ok: false,
        error: `Could not parse the container-page response: ${containerResult.stdout.slice(0, 300)}`,
      };
    }
  }

  // 2. Create the typed skills DB via the tools API (returns Markdown).
  const createResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "POST", "/v1/tools/run",
    "--notion-version", TYPED_NOTION_VERSION,
  ], {
    stdin: JSON.stringify({
      type: "create_database",
      create_database: {
        database_type: "skills",
        title: opts.dbName,
        parent: { type: "page_id", page_id: parentPageId },
      },
    }),
  });
  if (createResult.code !== 0) {
    return { ok: false, error: createResult.stderr || createResult.stdout };
  }

  let resultMarkdown: string;
  try {
    const wrapper = JSON.parse(createResult.stdout);
    resultMarkdown = typeof wrapper === "string" ? wrapper : wrapper.result;
  } catch {
    // Some responses may already be the raw Markdown string.
    resultMarkdown = createResult.stdout;
  }
  const parsed = parseCreateDatabaseResult(resultMarkdown ?? "");
  if (!parsed) {
    return {
      ok: false,
      error: `Could not parse the typed-database creation response: ${(resultMarkdown ?? "").slice(0, 400)}`,
    };
  }

  // 3. Confirm structured ids/url via a GET (the Markdown ids are enough to
  //    proceed, but this validates them and gives us the canonical url).
  let dataSourceId = parsed.dataSourceId;
  let databaseId = parsed.databaseId;
  let databaseUrl = parsed.databaseUrl;
  const getResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "GET", `/v1/databases/${parsed.databaseId}`,
    "--notion-version", NOTION_VERSION,
  ]);
  if (getResult.code === 0) {
    try {
      const db = JSON.parse(getResult.stdout);
      databaseId = db.id || databaseId;
      databaseUrl = db.url || databaseUrl;
      dataSourceId = db.data_sources?.[0]?.id || dataSourceId;
    } catch {
      /* keep the parsed values */
    }
  }

  // 4. Layer on the sync's extra properties (Published + Plugins).
  const patchResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "api", "-X", "PATCH", `/v1/data_sources/${dataSourceId}`,
    "--notion-version", NOTION_VERSION,
  ], { stdin: JSON.stringify({ properties: desiredExtraProperties() }) });
  if (patchResult.code !== 0) {
    return {
      ok: false,
      error: `Could not add the sync's extra properties: ${patchResult.stderr || patchResult.stdout}`,
    };
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
