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
 * actionable setup error before attempting to parse it as a successful typed
 * database creation result.
 */
export function describeTypedDbCreationFailure(
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

  if (error.status === 403 && error.code === "restricted_resource") {
    return (
      `${summary}${summary.endsWith(".") ? "" : "."}\n\n` +
      "The typed Skills database API is unavailable to this workspace. " +
      "Ask the Notion Public API team to enable the `public_api_skills_plugins` " +
      "feature gate for the workspace (and confirm this connection can create " +
      "databases), then run `bun run setup` again."
    );
  }

  return summary || stdout.trim();
}

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
 * Create the Notion Skills DB the sync expects: a typed skills database
 * (`database_type: skills`) carrying only the canonical schema (Skill name /
 * Description / Files / Created by). Parent defaults to the workspace top
 * level; pass parentPageId to nest it.
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
  opts: { dbName: string; parentPageId?: string },
): Promise<CreateSkillsDbResult> {
  const createDatabase: Record<string, unknown> = {
    database_type: "skills",
    title: opts.dbName,
  };
  if (opts.parentPageId) {
    createDatabase.parent = { type: "page_id", page_id: opts.parentPageId };
  }

  const createResult = await loggedExec(
    logger, step, "ntn",
    ntnApiArgs(notionEnv, "POST", "/v1/tools/run"),
    {
      stdin: JSON.stringify({ type: "create_database", create_database: createDatabase }),
    },
  );

  if (createResult.code !== 0) {
    return { ok: false, error: createResult.stderr || createResult.stdout };
  }

  const apiError = describeTypedDbCreationFailure(
    createResult.stdout,
    createResult.stderr,
  );
  if (apiError) return { ok: false, error: apiError };

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
  const getResult = await loggedExec(
    logger, step, "ntn",
    ntnApiArgs(notionEnv, "GET", `/v1/databases/${parsed.databaseId}`),
  );
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
            "Skill name": { title: [{ text: { content: skill.name } }] },
            Description: {
              rich_text: [{ text: { content: skill.description } }],
            },
            ...(filesValue ? { Files: filesValue } : {}),
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
