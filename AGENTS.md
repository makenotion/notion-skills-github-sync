# AGENTS.md — Instructions for AI Agents

This file contains instructions for AI agents working with this repository.

## Setting Up config.json

If `config.json` is missing, the sync will fail. Follow this setup flow to create it.

> **Communicating with users:** When showing the user what you've created or configured,
> always display **URLs** (e.g., `https://notion.so/workspace/abc123` or
> `https://github.com/my-org/my-skills`) rather than raw IDs. URLs are easier for users
> to recognize, click, and verify. The `config.json` file itself uses IDs internally.

### Step 1: Ensure Notion MCP is available

First, check that the Notion MCP server is installed and accessible. You'll need it to:
- Create databases (if the user doesn't have one)
- Resolve database IDs to data source IDs
- Query and update skills

If the Notion MCP isn't available, ask the user to add it to their agent's tools.

### Step 2: Create or use an existing skills database

> **Installing the `ntn` CLI:** If you need to use the `ntn` CLI and it's not already
> installed, run:
> ```bash
> curl -fsSL https://ntn.dev | bash
> ```
> This installs `ntn` to `/usr/local/bin`. Alternatively, use `npx --yes ntn <command>`
> to run it without a permanent install.

**Default: Create a new skills database** (recommended for new setups)

Use the Notion MCP's `create-database` tool with `database_type: skills` to create a
typed skills database:

```json
{
  "database_type": "skills",
  "title": "Skills"
}
```

This creates a database with the official Notion Skills schema (`Skill name`,
`Description`, `Created by`).

The typed schema is all the sync needs — it reads skills through Notion's Skills
Public API, which projects that schema directly. **Do not add `Published` or
`Plugins` properties**: the API has no per-row publish flag (access to the Notion
connection is what controls publishing) and reports a single workspace plugin, so
neither property would be read.

One optional property is worth adding:

1. **"Files"** (files) — for skills that ship more than a `SKILL.md`. Attachments
 are delivered alongside the rendered `SKILL.md`; attach a single `.zip` when you
 need nested folders (scripts, references) and it's expanded in place on sync. The
 `SKILL.md` always comes from Notion. Add the property via the API:

 ```bash
 echo '{"properties": {"Files": {"files": {}}}}' | \
   ntn api -X PATCH /v1/data_sources/<data-source-id> --notion-version 2025-09-03
 ```

After creating the database, set its permissions to **"Everyone in workspace can view"**
so team members can browse available skills. You can adjust this in the database's
share settings in Notion.

The response will include the data source ID in a `<data-source>` tag — save this as
`skillsDataSourceId`. The database ID is in the response URL.

**Alternative: Use an existing database**

If the user already has a skills database, ask them for the **database ID** (not the
data source ID). You can find it in the Notion URL, e.g.:
`https://notion.so/workspace/<database-id>?v=...`

Then use the `ntn` CLI to resolve it to a data source ID:

```bash
npx --yes ntn datasources resolve <database-id> --env dev --json
```

This returns the data source IDs for that database. Use the appropriate one as
`skillsDataSourceId`.

### Step 3: Add sample skills

To help users get started, create a few sample skills in the database. Focus on
general knowledge work skills rather than coding-specific ones:

**Example skills to create:**

1. **"Meeting Notes"** — "Helps structure and summarize meeting notes, capturing
   key decisions, action items, and follow-ups."

2. **"Document Review"** — "Reviews documents for clarity, completeness, and
   consistency. Suggests improvements and flags potential issues."

3. **"Research Summary"** — "Synthesizes research from multiple sources into
   clear, actionable summaries with key takeaways."

4. **"Email Drafting"** — "Helps compose professional emails with appropriate
   tone, structure, and call-to-action."

5. **"Project Planning"** — "Breaks down projects into phases, milestones, and
   tasks. Identifies dependencies and potential risks."

For each skill, fill in the `Skill name`, `Description`, and skill body content.
Every skill the sync's Notion connection can read is published — there's no
per-row checkbox — and they all land under `plugins/skills/` (change the
directory with `pluginSlug` in config.json).

### Step 4: Optionally create a change requests database

If the user wants the "propose a change" feature (for review workflows), create a
change requests database:

```sql
CREATE TABLE "Change Requests" (
  "Name" title,
  "Status" status,
  "Skill" relation("Skills"),
  "Context" rich_text
);
```

Save its data source ID as `changeRequestsDataSourceId`. This is optional — omit it
to disable the propose-a-change feature.

### Step 5: Choose or create a target GitHub repository

The sync tool publishes skills to a GitHub repository. You have two options:

**Option A: Create a new GitHub repository** (recommended for new setups)

Use the GitHub CLI to create a new repository that will serve as your skills
marketplace:

```bash
gh repo create <owner>/<repo-name> --private --description "Skills marketplace synced from Notion"
```

For example:
```bash
gh repo create my-org/notion-skills --private --description "Skills marketplace synced from Notion"
```

This creates a fresh private repo ready to receive synced skills. Initialize it
with an empty commit so the sync has a base to build on:

```bash
cd <local-clone-path>
git clone https://github.com/<owner>/<repo-name>.git .
git commit --allow-empty -m "Initial commit"
git push origin main
```

Use the resulting repository URL (e.g., `https://github.com/my-org/notion-skills`)
as your `githubRepo` value in config.json.

**Option B: Use an existing GitHub repository**

If you already have a repository you want to sync skills into, simply use its
`owner/repo` identifier. Make sure you have push access to the repository.

For example, if your repo URL is `https://github.com/my-org/my-skills`, your
`githubRepo` value would be `my-org/my-skills`.

### Step 6: Create config.json

Create a `config.json` file in the repository root:

```json
{
  "notionEnv": "prod",
  "skillsDataSourceId": "<from step 2>",
  "skillsDatabaseId": "<from step 2>",
  "changeRequestsDataSourceId": "<from step 4, or omit>",
  "githubRepo": "<from step 5>",
  "githubBranch": "main",
  "pluginsDir": "plugins",
  "authorName": "notion-skills-sync",
  "authorEmail": "notion-skills-sync@users.noreply.github.com"
}
```

Required fields:
- `githubRepo` — target repository in `owner/repo` format

Optional fields (with defaults):
- `notionEnv` — Notion environment: `dev`, `stg`, or `prod` (default: `prod`)
- `skillsDataSourceId` / `skillsDatabaseId` — not used to read skills; recorded in plugin back-references and the updater's write-back guidance
- `changeRequestsDataSourceId` — enables "propose a change" feature
- `githubBranch` — branch to sync into (default: `main`)
- `pluginsDir` — where plugins are generated (default: `plugins`)
- `pluginSlug` — the plugin directory all skills go into (default: `skills`)
- `authorName` / `authorEmail` — commit author info

### Step 7: Confirm the skills are visible to the API

The sync reads `GET /v1/skills/plugins` with `NOTION_API_TOKEN`. Two things
determine what comes back:

- The database must be a **typed** skills DB (`database_type: skills`). Convert
  an older one in-product via "Turn into → Skills DB"; an untyped DB reports zero
  skills.
- The Notion connection must have **read access** to the skills. That access *is*
  the publishing control — there is no `Published` checkbox.

Check it directly:

```bash
NOTION_API_TOKEN=<token> bun run dry-run
```

A `403 restricted_resource` means either the `public_api_skills_plugins` feature
gate is off for the workspace, or the token lacks read access.

## Common Operations

### Running a dry-run sync

```bash
bun run dry-run
```

### Running a real sync

```bash
bun run sync
```

### Type checking

```bash
bunx tsc --noEmit
```

### Running tests

```bash
bun test
```
