import { loggedExec } from "./exec.ts";
import type { WizardLogger } from "./logger.ts";
import { NOTION_API_VERSION } from "../notion/ntn.ts";
import { zipSkillFiles } from "../files.ts";
import { slugify } from "../slugify.ts";

/**
 * Shared Notion Skills DB creation: schema + sample skills.
 * Used by both the interactive wizard (resources phase) and the non-interactive
 * `--ci` runner so the flows can't drift apart.
 */

export const SKILLS_DB_DEFAULT_NAME = "Skills";

interface SampleSkill {
  name: string;
  description: string;
  body: string;
  /**
   * Extra files bundled with the skill (path at zip root -> content). Zipped
   * and attached to the page's Files property, so the sample set demonstrates
   * the file/zip flow end to end — the sync unpacks them into the skill dir.
   */
  files?: Record<string, string | Uint8Array>;
}

// A 320x80 indigo-gradient PNG banner (generated, 503 bytes) — gives the
// Meeting Notes sample a binary asset so the zip flow demonstrably carries
// more than text.
const NOTES_HEADER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAABQCAIAAADnUzvSAAABvklEQVR42u3TV1IaABgGwP90osaGYAFM78X03quJyTlFREFR8Tnn+GZ2Zq+wtTyzB4SqlZk9IFQ1G3tAqGo2+kCoWm30gVDVavSBUNWe7QOhqj27D4Sqtdl9IFStz+0DoWpjbh8IJTAkB96cGwChqjM/AEJVd34AhBIYkgP35gdAqNq6dACEqsuXDoBQAkNy4CsLB0CourowBELVtYUhEEpgSA58fXEIhKobi0MgVN1cPARC1a2lQyCUwJAc+PbSIRCq7iwdAqHq7vIREEpgSA58b/kICFX3l4+AUPVgZQSEEhiSAz9cGQGh6lFzBISq7eYICFXbzTEQqh43x0CoerI6BkLV09UxEEpgSA78rHUMhKrnrWMgVL1oHQOhBIbkwC/bJ0CoetU+AULV6/YJEEpgSA78Zu0ECFVv1yZAqHq3NgFC1fv1CRBKYEgO/GF9AoSqj+unQKj6tHEKhBIYkgN/3jgFQtWXzTMgVH3dPANCCQzJgb9tngGh6nvnDAhVPzrnQCiBITnwz845EKp+dc+BULXTPQdC1U53CoSq370pEKr+9KZAqNrtTYFQtdu7AELV360LIFT927oAQv0HSjQHyiVQWQAAAAAASUVORK5CYII=",
  "base64",
);

const SAMPLE_SKILLS: SampleSkill[] = [
  {
    name: "Meeting Notes",
    description:
      "Helps structure and summarize meeting notes, capturing key decisions, action items, and follow-ups.",
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

## Bundled files
This skill ships with supporting files in its directory:
- scripts/extract_action_items.py — run it over saved notes files (e.g. python3 scripts/extract_action_items.py notes/*.md) to collect every open action item into one follow-up list.
- assets/notes-header.png — the standard header banner; place it at the top of notes that get shared outside the team.

## Style
Keep it scannable. Use bullet points over paragraphs. Bold the owner of each action item and write action items as markdown checkboxes ("- [ ] **Owner** — task") so the bundled script can find them. Date everything.`,
    files: {
      "scripts/extract_action_items.py": `#!/usr/bin/env python3
"""Collect open action items from meeting-notes markdown files.

Usage: python3 extract_action_items.py notes/*.md
Prints every unchecked "- [ ] ..." line with the file it came from, so
follow-ups scattered across many meetings end up in one list.
"""
import re
import sys

OPEN_ITEM = re.compile(r"^\\s*-\\s*\\[ \\]\\s*(.+)$")


def main(paths):
    found = 0
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for line in f:
                match = OPEN_ITEM.match(line)
                if match:
                    print(f"{path}: {match.group(1).strip()}")
                    found += 1
    print(f"\\n{found} open action item(s)", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: extract_action_items.py <notes.md> [notes2.md ...]")
    main(sys.argv[1:])
`,
      "assets/notes-header.png": NOTES_HEADER_PNG,
    },
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
- Clarity — can a new reader follow this without prior context?
- Completeness — are there gaps in reasoning or missing sections?
- Consistency — do terms, tone, and formatting stay uniform?
- Actionability — does the reader know what to do next?`,
  },
  {
    name: "Research Summary",
    description:
      "Synthesizes research from multiple sources into clear, actionable summaries with key takeaways.",
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

/** Format a bare 32-hex Notion id as a canonical 8-4-4-4-12 UUID. */
function hyphenateId(hex: string): string {
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

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
  return {
    databaseId: hyphenateId(urlMatch[2]!),
    databaseUrl: urlMatch[1]!,
    dataSourceId: dsMatch[1]!,
  };
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
    "--notion-version", NOTION_API_VERSION,
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
    "--notion-version", NOTION_API_VERSION,
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
    "--notion-version", NOTION_API_VERSION,
  ], { stdin: JSON.stringify({ properties }) });
  if (patchResult.code !== 0) {
    return { ok: false, error: patchResult.stderr || patchResult.stdout };
  }
  return { ok: true };
}

/**
 * Create the Notion Skills DB the sync expects: a plain typed skills database.
 *
 * The sync reads skills through Notion's skills API, which projects the typed
 * schema directly — so there are no extra properties to bolt on. (This used to
 * add a `Published` checkbox and a `Plugins` select; both are gone. The API has
 * no per-row publish flag — what syncs is what the Notion connection can read —
 * and it reports a single workspace plugin rather than per-skill grouping.)
 */
export async function createSkillsDb(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  opts: { dbName: string; parentPageId?: string },
): Promise<CreateSkillsDbResult> {
  return await createTypedSkillsDb(logger, step, notionEnv, opts);
}

/**
 * Zip a sample skill's bundled files and upload them to Notion. Returns the
 * Files property value referencing the upload, or null if the upload failed
 * (the skill is still usable without its extras).
 */
async function uploadSkillFilesZip(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  skill: SampleSkill,
): Promise<Record<string, unknown> | null> {
  if (!skill.files) return null;
  const zipName = `${slugify(skill.name) || "skill"}.zip`;
  const uploadResult = await loggedExec(logger, step, "ntn", [
    "--env", notionEnv,
    "files", "create",
    "--filename", zipName,
    "--content-type", "application/zip",
    "--json",
  ], { stdin: zipSkillFiles(skill.files) });
  if (uploadResult.code !== 0) return null;
  try {
    const upload = JSON.parse(uploadResult.stdout) as { id?: string };
    if (!upload.id) return null;
    return {
      files: [{ type: "file_upload", name: zipName, file_upload: { id: upload.id } }],
    };
  } catch {
    return null;
  }
}

/** Populate the DB with sample skills. Returns created/total counts. */
export async function populateSampleSkills(
  logger: WizardLogger,
  step: string,
  notionEnv: string,
  dataSourceId: string,
): Promise<{ created: number; total: number; zipsAttached: number; zipsTotal: number }> {
  let created = 0;
  let zipsAttached = 0;
  const zipsTotal = SAMPLE_SKILLS.filter((s) => s.files).length;
  for (const skill of SAMPLE_SKILLS) {
    // Upload the bundled files (if any) first, so the page can be created with
    // the zip already attached to its Files property.
    const filesValue = await uploadSkillFilesZip(logger, step, notionEnv, skill);
    const pageResult = await loggedExec(logger, step, "ntn", [
      "--env", notionEnv,
      "api", "-X", "POST", "/v1/pages",
      "--notion-version", NOTION_API_VERSION,
    ], {
      stdin: JSON.stringify({
        parent: { data_source_id: dataSourceId },
        properties: {
          "Skill name": { title: [{ text: { content: skill.name } }] },
          Description: {
            rich_text: [{ text: { content: skill.description } }],
          },
          ...(filesValue ? { Files: filesValue } : {}),
        },
        children: bodyToBlocks(skill.body),
      }),
    });
    if (pageResult.code === 0) {
      created++;
      if (filesValue) zipsAttached++;
    }
  }
  return { created, total: SAMPLE_SKILLS.length, zipsAttached, zipsTotal };
}

/**
 * Probe whether `token` can read the given data source — used to poll for the
 * "connect the integration to the Notion Skills DB" manual step completing.
 *
 * Deliberately probes the data source rather than the Skills API the sync
 * actually uses: this checks exactly the thing the user was just asked to do
 * (attach the connection), and it isn't gated. Probing `/v1/ai/plugins`
 * here would fail on a workspace without the `public_api_skills_plugins` gate
 * even though the connection step was done correctly — the dry-run later in
 * setup surfaces that case with a message that explains it.
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
    "--notion-version", NOTION_API_VERSION,
  ], { env: { NOTION_API_TOKEN: token } });
  return result.code === 0;
}
