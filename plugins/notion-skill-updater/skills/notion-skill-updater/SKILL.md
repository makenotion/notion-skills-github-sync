---
description: Use when the user wants to edit, rename, improve, propose a change to, or create a Cowork skill (the skills installed from this Notion-backed marketplace). Writes the change back to its source in Notion via the Notion MCP so it persists across syncs.
---

# Updating Cowork skills

These skills are generated from a Notion database, which is the **source of truth** —
the skill lives **in Notion**, not in these local files. When you change a skill, the
change is written **back to Notion** via the bundled **Notion MCP server**, and it flows
into the marketplace on the next sync. Editing the local `SKILL.md` files directly will
**not** stick — they're overwritten on the next sync.

This deployment targets the **dev** Notion workspace.

## Before you change anything

1. Find the skill's back-reference: open the `.notion-sync.json` next to that skill's
   `SKILL.md`. It contains:
   - `notion.pageId` — the Notion page that backs this skill
   - `notion.url` — open in a browser if useful
   - `notion.skillsDataSourceId`, `notion.env`
2. **Tell the user the change will be saved to Notion** — that's where the skill is
   stored, not in these local files. Many users won't know this; say it explicitly.
3. **Give a concise overview of what you'll change, and ask for an OK** before writing
   anything. If it's a **small** edit, just show the exact change inline (it's quick to
   read). If it's a **larger** edit, summarize the changes at a high level rather than
   pasting the full rewrite.
4. **Offer to show the exact change first** (the precise new wording / a diff) in
   case they want to review it in detail, then edit the skill directly.

## Edit the skill directly (default)

Use the Notion MCP to update the skill's page (`notion.pageId`):
- **Instructions / behavior** (the skill body) → update the page **content**.
- **Description** ("when to use") → update the **Description** property.
- **Rename** → update the **Skill name** (title). Note: this changes the skill's
  folder/slug on the next sync.

Let the user know the change appears in the marketplace on the next sync (they may need
to update/reinstall the plugin to pick it up).

## Create a new skill

1. Gather from the user: a short **Skill name**, a one-line **Description**
   ("use this when…"), and the **body** (the instructions).
2. Use the Notion MCP to create a new page in the skills data source:
   - data source id: `1c56f41f-0c6f-4b6b-b764-3a8fbb4d9e31`
   - set **Skill name**, **Description**, and the page **content** (body)
   - set the **Published** checkbox to checked when it's ready to share (leave it
     unchecked to keep the skill a draft).
3. Only **Published** skills are synced into the marketplace.

## Notes

- Don't hand-edit the generated files in this repo — they are regenerated from Notion.
- If the Notion MCP isn't authenticated yet, you'll be prompted to authorize it in the
  browser on first use.
