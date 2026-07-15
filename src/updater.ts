import type { MarketplaceEntry } from "./convert.ts";

// A synthetic plugin the sync injects into the marketplace (not sourced from
// Notion). It carries the Notion MCP wiring + a skill that teaches a Cowork
// client how to edit/create skills back in Notion (the source of truth).
export interface InjectedPlugin {
  slug: string;
  files: Record<string, string>; // repo-relative path -> content
  entry: MarketplaceEntry;
}

// Notion remote MCP endpoint for an environment.
//   prod -> https://mcp.notion.com/mcp
//   dev  -> https://mcp-dev.notion.com/mcp   (and mcp-<env> for others)
export function notionMcpUrl(env: string): string {
  const host = env === "prod" ? "mcp.notion.com" : `mcp-${env}.notion.com`;
  return `https://${host}/mcp`;
}

// The mcpServers key — i.e. the connection's display name in the MCP client's
// list. Env-suffixed for non-prod so a user can tell a dev connector apart from
// the prod one (e.g. "notion-dev" vs "notion").
export function notionMcpServerName(env: string): string {
  return env === "prod" ? "notion" : `notion-${env}`;
}

const json = (obj: unknown): string => JSON.stringify(obj, null, 2) + "\n";

function pluginJson(slug: string, env: string): string {
  return json({
    name: slug,
    version: "1.0.0",
    description:
      "Edit or create Cowork skills by updating their source in Notion (write-back via the Notion MCP).",
    author: { name: "notion-skills-github-sync" },
    // Bundled Notion MCP server; OAuth is prompted interactively on first use.
    // Keyed by env so the connection is distinguishable in the client (e.g.
    // "notion-dev" vs "notion").
    mcpServers: {
      [notionMcpServerName(env)]: {
        type: "http",
        url: notionMcpUrl(env),
      },
    },
  });
}

// Guidance for the file/folder support: a skill's extra files (scripts,
// references, nested folders) travel as a single zip on the Notion page's
// "Files" property. On sync the zip is unpacked into the skill dir and the
// Notion-generated SKILL.md is layered on top. Writing files back requires the
// `ntn` CLI (file uploads aren't exposed over the MCP), so this teaches the
// agent the whole install → auth → zip → upload → attach loop.
function filesSection(env: string): string {
  return `## Add or update the skill's files (scripts, references, nested folders)

A skill can ship more than a \`SKILL.md\` — helper scripts, reference docs, whole
folders. Those extra files travel as a **single \`.zip\` attached to the skill page's
\`Files\` property** in Notion. On each sync the zip is **unpacked into the skill's
directory**, then the \`SKILL.md\` is **overwritten from the Notion page** (Notion is the
source of truth for the skill body). So: the page body is the instructions; the zip is
everything else.

The **contract** (keep it simple, it's easy to get wrong):
- Attach **exactly one** \`.zip\`. Loose files or multiple zips are ignored.
- Zip the **contents at the archive root**, not a wrapping folder — e.g. the archive
  should contain \`scripts/run.py\`, not \`my-skill/scripts/run.py\`.
- Any \`SKILL.md\` inside the zip is ignored (the page body wins).
- To **remove** a file, upload a new zip without it (or clear the \`Files\` property) —
  the sync prunes files that are no longer in the zip.

Notion's MCP can't upload files, so use the **\`ntn\` CLI**. Walk the user through it:

1. **Install \`ntn\`** (no global install needed): prefix commands with \`npx --yes ntn\`,
   e.g. \`npx --yes ntn --version\`.
2. **Authenticate:** \`npx --yes ntn --env ${env} login\` (opens a browser). If nothing
   opens and there's no clear error, a Notion **workspace admin** likely restricts
   personal access tokens ("Limit who can create personal access tokens", Admin Center →
   Connections → Manage) — an admin must allow it (it can be re-restricted afterward).
3. **Build the zip** from the skill's extra files, contents at the root:
   \`\`\`bash
   cd path/to/skill-files      # a dir holding scripts/, references/, etc.
   zip -r ../skill.zip . -x '*.DS_Store'
   \`\`\`
4. **Upload the zip** and copy the returned \`id\`:
   \`\`\`bash
   npx --yes ntn --env ${env} files create --filename skill.zip \\
     --content-type application/zip --json < ../skill.zip
   \`\`\`
5. **Attach it** to the page's \`Files\` property (use \`notion.pageId\` from the skill's
   \`.notion-sync.json\`). This replaces the property's file list with just the new zip:
   \`\`\`bash
   npx --yes ntn --env ${env} api -X PATCH /v1/pages/<pageId> \\
     --notion-version 2025-09-03 <<'JSON'
   { "properties": { "Files": { "files": [
     { "type": "file_upload", "name": "skill.zip", "file_upload": { "id": "<upload-id>" } }
   ] } } }
   JSON
   \`\`\`
6. The files appear in the skill's directory on the **next sync** (SKILL.md still comes
   from the Notion page).

`;
}

function skillMarkdown(opts: {
  env: string;
  skillsDataSourceId: string;
  changeRequestsDataSourceId: string;
}): string {
  const { env, skillsDataSourceId, changeRequestsDataSourceId } = opts;
  const canPropose = changeRequestsDataSourceId.trim().length > 0;

  const description =
    "Use when the user wants to edit, rename, improve, propose a change to, or create a " +
    "Cowork skill (the skills installed from this Notion-backed marketplace). Writes the " +
    "change back to its source in Notion via the Notion MCP so it persists across syncs.";

  // The "how should we land this" choice only makes sense when change requests
  // are wired up for this deployment.
  const landingChoice = canPropose
    ? `4. **Lay out the options and let the user pick — default to a direct edit:**
   - **Edit the skill directly** (default) — write the change straight to the skill's
     Notion page.
   - **Propose a change for review** — instead of editing, file a change request in
     Notion that links to this skill, so someone else can review and apply it.
   - **Review the exact change first** — offer to show the precise new wording / a diff
     before anything is written, in case they want to check it in detail.

   Use judgment on what to recommend: **lean toward proposing a change for review** when
   the edit is large, structural, or touches sensitive or widely-used behavior (rewrites,
   behavior changes, renames). A small wording fix is fine to just edit directly.`
    : `4. **Offer to show the exact change first** (the precise new wording / a diff) in
   case they want to review it in detail, then edit the skill directly.`;

  const proposeSection = canPropose
    ? `

## Propose a change for review (instead of editing)

In this mode you **don't touch the skill's page**. You create a new page in the
**Change Requests** data source; the review and apply are handled downstream by Notion
workflows. Creating the page is all you need to do.

Use the Notion MCP to create a page in the change requests data source:
- data source id: \`${changeRequestsDataSourceId}\`
- **Name** — a short title for the proposed change.
- **Skill** (relation) — link it to the skill's page (use \`notion.pageId\` / \`notion.url\`
  from the skill's \`.notion-sync.json\`) so reviewers know which skill it targets.
- page **content** — write two things:
  1. **Context** — what happened in this chat and why the skill needs updating.
  2. **Proposed change** — the specific edit you're suggesting (the concrete new wording).
- Leave **Status** at its default (**Proposed**).

Let the user know the change request was filed in Notion and will be reviewed there.`
    : "";

  const body = `# Updating Cowork skills

These skills are generated from a Notion database, which is the **source of truth** —
the skill lives **in Notion**, not in these local files. When you change a skill, the
change is written **back to Notion** via the bundled **Notion MCP server**, and it flows
into the marketplace on the next sync. Editing the local \`SKILL.md\` files directly will
**not** stick — they're overwritten on the next sync.

This deployment targets the **${env}** Notion workspace.

## Before you change anything

1. Find the skill's back-reference: open the \`.notion-sync.json\` next to that skill's
   \`SKILL.md\`. It contains:
   - \`notion.pageId\` — the Notion page that backs this skill
   - \`notion.url\` — open in a browser if useful
   - \`notion.skillsDataSourceId\`, \`notion.env\`
2. **Tell the user the change will be saved to Notion** — that's where the skill is
   stored, not in these local files. Many users won't know this; say it explicitly.
3. **Give a concise overview of what you'll change, and ask for an OK** before writing
   anything. If it's a **small** edit, just show the exact change inline (it's quick to
   read). If it's a **larger** edit, summarize the changes at a high level rather than
   pasting the full rewrite.
${landingChoice}

## Edit the skill directly (default)

Use the Notion MCP to update the skill's page (\`notion.pageId\`):
- **Instructions / behavior** (the skill body) → update the page **content**.
- **Description** ("when to use") → update the **Description** property.
- **Rename** → update the **Skill name** (title). Note: this changes the skill's
  folder/slug on the next sync.

Let the user know the change appears in the marketplace on the next sync (they may need
to update/reinstall the plugin to pick it up).${proposeSection}

${filesSection(env)}

## Create a new skill

1. Gather from the user: a short **Skill name**, a one-line **Description**
   ("use this when…"), and the **body** (the instructions).
2. Use the Notion MCP to create a new page in the skills data source:
   - data source id: \`${skillsDataSourceId}\`
   - set **Skill name**, **Description**, and the page **content** (body)
   - set the **Published** checkbox to checked when it's ready to share (leave it
     unchecked to keep the skill a draft).
3. Only **Published** skills are synced into the marketplace.

## Notes

- Don't hand-edit the generated files in this repo — they are regenerated from Notion.
- If the Notion MCP isn't authenticated yet, you'll be prompted to authorize it in the
  browser on first use.
`;
  return `---\ndescription: ${description}\n---\n\n${body}`;
}

export function buildUpdaterPlugin(opts: {
  pluginsDir: string;
  slug: string;
  env: string;
  skillsDataSourceId: string;
  changeRequestsDataSourceId?: string;
}): InjectedPlugin {
  const { pluginsDir, slug, env, skillsDataSourceId } = opts;
  const changeRequestsDataSourceId = opts.changeRequestsDataSourceId ?? "";
  const root = `${pluginsDir}/${slug}`;
  return {
    slug,
    files: {
      [`${root}/.claude-plugin/plugin.json`]: pluginJson(slug, env),
      [`${root}/skills/${slug}/SKILL.md`]: skillMarkdown({
        env,
        skillsDataSourceId,
        changeRequestsDataSourceId,
      }),
    },
    entry: {
      name: slug,
      source: `./${pluginsDir}/${slug}`,
      description:
        "Edit or create Cowork skills by updating their source in Notion.",
    },
  };
}
