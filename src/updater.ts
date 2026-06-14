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

function skillMarkdown(env: string, dataSourceId: string): string {
  const description =
    "Use when the user wants to edit, rename, improve, or create a Cowork skill " +
    "(the skills installed from this Notion-backed marketplace). Updates the source " +
    "of truth in Notion via the Notion MCP so changes persist across syncs.";
  const body = `# Updating Cowork skills

These skills are generated from a Notion database, which is the **source of truth**.
Editing the local \`SKILL.md\` files will **not** stick — they are overwritten on the
next sync. To change a skill, edit its page in Notion using the bundled **Notion MCP
server**, and the change flows back into the marketplace on the next sync.

This deployment targets the **${env}** Notion workspace.

## Edit an existing skill

1. Find the skill's back-reference: open the \`.notion-sync.json\` file next to that
   skill's \`SKILL.md\`. It contains:
   - \`notion.pageId\` — the Notion page to edit
   - \`notion.url\` — open in a browser if useful
   - \`notion.dataSourceId\`, \`notion.env\`
2. Confirm with the user exactly what should change.
3. Use the Notion MCP to update that page:
   - **Instructions / behavior** (the skill body) → update the page **content**.
   - **Description** ("when to use") → update the **Description** property.
   - **Rename** → update the **Skill name** (title). Note: this changes the skill's
     folder/slug on the next sync.
4. Let the user know the change appears in the marketplace on the next sync (they may
   need to update/reinstall the plugin to pick it up).

## Create a new skill

1. Gather from the user: a short **Skill name**, a one-line **Description**
   ("use this when…"), and the **body** (the instructions).
2. Use the Notion MCP to create a new page in the skills data source:
   - data source id: \`${dataSourceId}\`
   - set **Skill name**, **Description**, and the page **content** (body)
   - set the **Published** checkbox to checked when it's ready to share (leave it
     unchecked to keep the skill a draft).
3. Only **Published** skills are synced into the marketplace.

## Notes

- Always show the user a summary of the change before writing to Notion.
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
  dataSourceId: string;
}): InjectedPlugin {
  const { pluginsDir, slug, env, dataSourceId } = opts;
  const root = `${pluginsDir}/${slug}`;
  return {
    slug,
    files: {
      [`${root}/.claude-plugin/plugin.json`]: pluginJson(slug, env),
      [`${root}/skills/${slug}/SKILL.md`]: skillMarkdown(env, dataSourceId),
    },
    entry: {
      name: slug,
      source: `./${pluginsDir}/${slug}`,
      description:
        "Edit or create Cowork skills by updating their source in Notion.",
    },
  };
}
