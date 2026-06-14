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

function skillMarkdown(opts: {
  env: string;
  dataSourceId: string;
  changeRequestsDataSourceId: string;
}): string {
  const { env, dataSourceId, changeRequestsDataSourceId } = opts;
  const canPropose = changeRequestsDataSourceId.trim().length > 0;

  const description =
    "Use when the user wants to edit, rename, improve, propose a change to, or create a " +
    "Cowork skill (the skills installed from this Notion-backed marketplace). Writes the " +
    "change back to its source in Notion via the Notion MCP so it persists across syncs.";

  // The "how should we land this" choice only makes sense when change requests
  // are wired up for this deployment.
  const landingChoice = canPropose
    ? `4. Ask **how** to land the change (default to the first):
   - **Edit the skill directly** — write the change straight to the skill's Notion page.
   - **Propose a change for review** — instead of editing, file a change request in
     Notion that links to this skill, so someone else can review and apply it. Offer
     this when the user isn't the skill's owner, wants a second set of eyes, or is
     unsure about the change.`
    : `4. Default to editing the skill directly.`;

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
   - \`notion.dataSourceId\`, \`notion.env\`
2. **Tell the user the change will be saved to Notion** — that's where the skill is
   stored, not in these local files. Many users won't know this; say it explicitly.
3. **Concisely describe the change at a high level and ask for an OK** before writing
   anything — a sentence or two, not the full rewrite. Also **offer to show the exact
   change first** (the precise new wording / a diff) if they'd like to review in detail.
${landingChoice}

## Edit the skill directly (default)

Use the Notion MCP to update the skill's page (\`notion.pageId\`):
- **Instructions / behavior** (the skill body) → update the page **content**.
- **Description** ("when to use") → update the **Description** property.
- **Rename** → update the **Skill name** (title). Note: this changes the skill's
  folder/slug on the next sync.

Let the user know the change appears in the marketplace on the next sync (they may need
to update/reinstall the plugin to pick it up).${proposeSection}

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
  changeRequestsDataSourceId?: string;
}): InjectedPlugin {
  const { pluginsDir, slug, env, dataSourceId } = opts;
  const changeRequestsDataSourceId = opts.changeRequestsDataSourceId ?? "";
  const root = `${pluginsDir}/${slug}`;
  return {
    slug,
    files: {
      [`${root}/.claude-plugin/plugin.json`]: pluginJson(slug, env),
      [`${root}/skills/${slug}/SKILL.md`]: skillMarkdown({
        env,
        dataSourceId,
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
