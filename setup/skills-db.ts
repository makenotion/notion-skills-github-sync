import { loggedExec } from "./exec.ts";
import type { SetupLogger } from "./logger.ts";
import { ntnApiArgs } from "./ntn-cli.ts";
import { zipSkillFiles } from "../src/notion/archive.ts";
import { slugify } from "../src/sync/slugify.ts";

/**
 * Shared Notion Skills DB creation: schema + sample skills.
 * Used by both the interactive setup (resources phase) and the non-interactive
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

/**
 * Notion page URLs end in either a hyphenated UUID or a compact 32-hex ID.
 * Accept an ID directly as well, so callers do not have to trim a URL.
 */
export function normalizeNotionPageId(value: string): string | null {
  const match = value.trim().match(
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32}/iu,
  );
  if (!match) return null;
  const compact = match[0].replaceAll("-", "");
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

export type CreateSkillsDbResult =
  | { ok: true; db: CreatedSkillsDb }
  | { ok: false; error: string };

interface NotionApiErrorResponse {
  object?: string;
  status?: number;
  code?: string;
  message?: string;
}

/**
 * `ntn api` intentionally exits zero for a syntactically valid API response,
 * even if that response is a Notion error object. Turn that object into an
 * actionable setup error before attempting to parse it as a successful
 * database creation result.
 */
export function describeDatabaseCreationFailure(
  stdout: string,
  stderr: string,
): string | null {
  if (stderr.trim()) return stderr.trim();

  let error: NotionApiErrorResponse;
  try {
    error = JSON.parse(stdout) as NotionApiErrorResponse;
  } catch {
    return null;
  }

  if (error.object !== "error") return null;

  const summary = [
    error.status ? `Notion returned ${error.status}` : "Notion returned an error",
    error.code,
    error.message,
  ].filter(Boolean).join(" ");

  return summary || stdout.trim();
}

/** Build the normal Public API request for a typed Skills database. */
export function buildCreateSkillsDbRequest(
  opts: { dbName: string; parentPageId: string },
): Record<string, unknown> {
  return {
    parent: { type: "page_id", page_id: opts.parentPageId },
    database_type: "skills",
    title: [{ type: "text", text: { content: opts.dbName } }],
  };
}

/** Parse the structured response from POST /v1/databases. */
export function parseCreatedSkillsDb(
  stdout: string,
): CreatedSkillsDb | null {
  try {
    const db = JSON.parse(stdout) as {
      id?: unknown;
      url?: unknown;
      database_type?: unknown;
      data_sources?: Array<{ id?: unknown }>;
    };
    const dataSourceId = db.data_sources?.[0]?.id;
    if (
      db.database_type !== "skills" ||
      typeof db.id !== "string" ||
      typeof db.url !== "string" ||
      typeof dataSourceId !== "string"
    ) {
      return null;
    }
    return { databaseId: db.id, databaseUrl: db.url, dataSourceId };
  } catch {
    return null;
  }
}

/**
 * Create the Notion Skills DB the sync expects: a typed skills database
 * (`database_type: skills`) carrying Notion's canonical schema (Skill name /
 * Description / Files / Tags / Created by), nested under an editable Notion
 * page. Creating at the workspace root makes the database inaccessible in the
 * Notion UI for some user-owned API credentials, so a parent is required.
 *
 * The sync reads skills through Notion's skills API, which projects that typed
 * schema directly — so there are no extra properties to bolt on. (This used to
 * add a `Published` checkbox and a `Plugins` select; both are gone. The API has
 * no per-row publish flag — what syncs is what the Notion connection can read —
 * and it reports a single workspace plugin rather than per-skill grouping.)
 */
export async function createSkillsDb(
  logger: SetupLogger,
  step: string,
  notionEnv: string,
  opts: { dbName: string; parentPageId: string },
): Promise<CreateSkillsDbResult> {
  const createResult = await loggedExec(
    logger, step, "ntn",
    ntnApiArgs(notionEnv, "POST", "/v1/databases"),
    {
      stdin: JSON.stringify(buildCreateSkillsDbRequest(opts)),
    },
  );

  if (createResult.code !== 0) {
    return { ok: false, error: createResult.stderr || createResult.stdout };
  }

  const apiError = describeDatabaseCreationFailure(
    createResult.stdout,
    createResult.stderr,
  );
  if (apiError) return { ok: false, error: apiError };

  const parsed = parseCreatedSkillsDb(createResult.stdout);
  if (!parsed) {
    return {
      ok: false,
      error: `Could not parse the typed Skills database response: ${createResult.stdout.slice(0, 300)}`,
    };
  }
  return { ok: true, db: parsed };
}

interface SkillsPropertyKeys {
  skillName: string;
  description: string;
  files: string;
}

const DEFAULT_SKILLS_PROPERTY_KEYS: SkillsPropertyKeys = {
  skillName: "Skill name",
  description: "Description",
  files: "Files",
};

/**
 * Resolve typed property IDs from a data source response. Typed schemas use
 * the token owner's locale for their display names, while property IDs are
 * stable and can always be supplied when creating pages.
 */
export function getSkillsPropertyKeys(stdout: string): SkillsPropertyKeys {
  try {
    const dataSource = JSON.parse(stdout) as {
      properties?: Record<string, { id?: unknown; type?: unknown }>;
    };
    const keys = { ...DEFAULT_SKILLS_PROPERTY_KEYS };
    for (const property of Object.values(dataSource.properties ?? {})) {
      if (typeof property.id !== "string") continue;
      if (property.type === "title") keys.skillName = property.id;
      if (property.type === "rich_text") keys.description = property.id;
      if (property.type === "files") keys.files = property.id;
    }
    return keys;
  } catch {
    return { ...DEFAULT_SKILLS_PROPERTY_KEYS };
  }
}

/**
 * Zip a sample skill's bundled files and upload them to Notion. Returns the
 * Files property value referencing the upload, or null if the upload failed
 * (the skill is still usable without its extras).
 */
async function uploadSkillFilesZip(
  logger: SetupLogger,
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
  logger: SetupLogger,
  step: string,
  notionEnv: string,
  dataSourceId: string,
): Promise<{ created: number; total: number; zipsAttached: number; zipsTotal: number }> {
  let created = 0;
  let zipsAttached = 0;
  const zipsTotal = SAMPLE_SKILLS.filter((s) => s.files).length;
  const dataSourceResult = await loggedExec(
    logger, step, "ntn",
    ntnApiArgs(notionEnv, "GET", `/v1/data_sources/${dataSourceId}`),
  );
  const propertyKeys = getSkillsPropertyKeys(dataSourceResult.stdout);
  for (const skill of SAMPLE_SKILLS) {
    // Upload the bundled files (if any) first, so the page can be created with
    // the zip already attached to its Files property.
    const filesValue = await uploadSkillFilesZip(logger, step, notionEnv, skill);
    const pageResult = await loggedExec(
      logger, step, "ntn",
      ntnApiArgs(notionEnv, "POST", "/v1/pages"),
      {
        stdin: JSON.stringify({
          parent: { data_source_id: dataSourceId },
          properties: {
            [propertyKeys.skillName]: { title: [{ text: { content: skill.name } }] },
            [propertyKeys.description]: {
              rich_text: [{ text: { content: skill.description } }],
            },
            ...(filesValue ? { [propertyKeys.files]: filesValue } : {}),
          },
          children: bodyToBlocks(skill.body),
        }),
      },
    );
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
  logger: SetupLogger,
  step: string,
  notionEnv: string,
  token: string,
  dataSourceId: string,
): Promise<boolean> {
  const result = await loggedExec(
    logger, step, "ntn",
    ntnApiArgs(notionEnv, "GET", `/v1/data_sources/${dataSourceId}`),
    { env: { NOTION_API_TOKEN: token } },
  );
  return result.code === 0;
}
