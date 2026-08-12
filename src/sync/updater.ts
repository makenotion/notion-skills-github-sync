import { mcpServerName, mcpUrl, type NotionEnv } from "../notion/env.ts";
import { claudePluginManifestPath, type MarketplaceEntryInput } from "./clients.ts";

// A synthetic plugin the sync injects into the marketplace (not sourced from
// Notion). It carries the Notion MCP wiring + a skill that teaches a Cowork
// client how to edit/create skills back in Notion (the source of truth).
export interface InjectedPlugin {
  slug: string;
  files: Record<string, string>; // target-relative path -> content
  // Client-neutral marketplace listing; the plan renders it per client.
  entry: MarketplaceEntryInput;
}

const json = (obj: unknown): string => JSON.stringify(obj, null, 2) + "\n";

// One string, two places: the plugin manifest and the marketplace entry.
const DESCRIPTION = "Edit or create Cowork skills by updating their source in Notion.";

function pluginJson(slug: string, env: NotionEnv): string {
  return json({
    $schema: "https://agent-plugins.org/schema/1.0.0/plugin.json",
    name: slug,
    version: "1.0.0",
    description: DESCRIPTION,
    author: { name: "notion-skills-github-sync" },
    // Bundled Notion MCP server; OAuth is prompted interactively on first use.
    // Keyed by env so the connection is distinguishable in the client (e.g.
    // "notion-dev" vs "notion").
    mcpServers: {
      [mcpServerName(env)]: {
        type: "http",
        url: mcpUrl(env),
      },
    },
  });
}

// Guidance for the file/folder support: a skill's extra files (scripts,
// references, nested folders) travel as a single zip on the Notion page's
// "Files" property; on sync it's unpacked into the skill dir with the
// Notion-generated SKILL.md layered on top. The read side is a one-paragraph
// mention — the part an agent actually has to *do* is the write path, since
// Notion's MCP can't upload files, so this teaches the whole
// zip → upload → attach loop via the `ntn` CLI.
function filesSection(env: NotionEnv): string {
  return `## Add or update the skill's files (scripts, references, nested folders)

A skill can ship more than a \`SKILL.md\` — helper scripts, reference docs, whole
folders. Those come from the skill page's \`Files\` property. Loose attachments land
flat next to \`SKILL.md\`; to ship **nested folders**, attach a single \`.zip\`, whose
contents are unpacked into the skill's directory on sync. The \`SKILL.md\` always
comes from the Notion page, even if the zip has its own.

Notion's MCP can't upload files, so writing extra files back means **building and
uploading a zip with the \`ntn\` CLI**, then attaching it to the page. Walk the user
through it:

1. **Install \`ntn\`** (no global install needed): prefix commands with \`npx --yes ntn\`,
   e.g. \`npx --yes ntn --version\`.
2. **Authenticate:** \`npx --yes ntn --env ${env} login\` (opens a browser). If nothing
   opens and there's no clear error, a Notion **workspace admin** likely restricts
   personal access tokens ("Limit who can create personal access tokens", Admin Center →
   Connections → Manage) — an admin must allow it (it can be re-restricted afterward).
3. **Build the zip**, contents at the archive root (not a wrapping folder — the archive
   should contain \`scripts/run.py\`, not \`my-skill/scripts/run.py\`). A \`SKILL.md\` at the
   root is fine to leave in; it's ignored on sync either way:
   \`\`\`bash
   cd path/to/skill-files      # a dir holding scripts/, references/, etc.
   zip -r ../skill.zip . -x '*.DS_Store'
   \`\`\`
4. **Upload the zip** and copy the returned \`id\`:
   \`\`\`bash
   npx --yes ntn --env ${env} files create --filename skill.zip \\
     --content-type application/zip --json < ../skill.zip
   \`\`\`
5. **Attach it** to the page's \`Files\` property, using the skill's Notion page id
   (the page you located above). This replaces the property's file list with just
   the new zip:
   \`\`\`bash
   npx --yes ntn --env ${env} api -X PATCH /v1/pages/<skill-page-id> \\
     --notion-version 2025-09-03 <<'JSON'
   { "properties": { "Files": { "files": [
     { "type": "file_upload", "name": "skill.zip", "file_upload": { "id": "<upload-id>" } }
   ] } } }
   JSON
   \`\`\`
6. The files appear in the skill's directory on the **next sync**. To remove a file,
   repeat this with a zip that no longer contains it — the sync prunes what's missing.

`;
}

function skillMarkdown(opts: { env: NotionEnv; skillsDataSourceId: string }): string {
  const { env, skillsDataSourceId } = opts;

  const description =
    "Use when the user wants to edit, rename, improve, or create a " +
    "Cowork skill (the skills installed from this Notion-backed marketplace). Writes the " +
    "change back to its source in Notion via the Notion MCP so it persists across syncs.";

  const body = `# Updating Cowork skills

These skills are generated from a Notion database, which is the **source of truth** —
the skill lives **in Notion**, not in these local files. When you change a skill, the
change is written **back to Notion** via the bundled **Notion MCP server**, and it flows
into the marketplace on the next sync. Editing the local \`SKILL.md\` files directly will
**not** persist — the plugin is replaced from Notion the next time its version changes.

This deployment targets the **${env}** Notion workspace.

## Before you change anything

1. **Find the skill's page in Notion.** The API publishes plugins, not individual
   skills, so there is no stored page id for a skill — look it up:
   - The skill's \`SKILL.md\` frontmatter \`name\` is its Notion page title. Search for
     it with the Notion MCP, scoped to the skills data source
     (\`${skillsDataSourceId}\`).
   - Context for the search is in the **plugin's** \`.notion-sync.json\`, at the root of
     the plugin directory (two levels up from \`SKILL.md\`): \`notion.env\`,
     \`notion.skillsDataSourceId\`, and \`notion.pluginId\`.
   - If the search returns several candidates, ask the user which one rather than
     guessing — editing the wrong skill is silent and confusing.
2. **Tell the user the change will be saved to Notion** — that's where the skill is
   stored, not in these local files. Many users won't know this; say it explicitly.
3. **Give a concise overview of what you'll change, and ask for an OK** before writing
   anything. If it's a **small** edit, just show the exact change inline (it's quick to
   read). If it's a **larger** edit, summarize the changes at a high level rather than
   pasting the full rewrite.
4. **Offer to show the exact change first** (the precise new wording / a diff) in
   case they want to review it in detail, then edit the skill directly.

## Edit the skill

Use the Notion MCP to update the skill's page (the one you located above):
- **Instructions / behavior** (the skill body) → update the page **content**.
- **Description** ("when to use") → update the **Description** property.
- **Rename** → update the **Skill name** (title). Note: this changes the skill's
  folder/slug on the next sync.

Let the user know the change appears in the marketplace on the next sync (they may need
to update/reinstall the plugin to pick it up).

${filesSection(env)}

## Create a new skill

1. Gather from the user: a short **Skill name**, a one-line **Description**
   ("use this when…"), and the **body** (the instructions).
2. Use the Notion MCP to create a new page in the skills data source:
   - data source id: \`${skillsDataSourceId}\`
   - set **Skill name**, **Description**, and the page **content** (body)
3. Every skill the sync's Notion connection can read is published to the
   marketplace — there is no draft checkbox. If a skill isn't ready to share, keep
   it outside the connection's access until it is.
4. If the new skill needs scripts, references, or other extra files: build the
   whole skill locally first (the full folder of extras, as if it already lived in
   the repo), then follow the zip → upload → attach steps above against this new
   page to ship them.

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
  env: NotionEnv;
  skillsDataSourceId: string;
}): InjectedPlugin {
  const { pluginsDir, slug, env, skillsDataSourceId } = opts;
  const root = `${pluginsDir}/${slug}`;
  const manifest = pluginJson(slug, env);
  const files: Record<string, string> = {
    [`${root}/plugin.json`]: manifest,
    [claudePluginManifestPath(root)]: manifest,
    [`${root}/skills/${slug}/SKILL.md`]: skillMarkdown({ env, skillsDataSourceId }),
  };
  return {
    slug,
    files,
    entry: {
      name: slug,
      source: `./${pluginsDir}/${slug}`,
      description: DESCRIPTION,
    },
  };
}
