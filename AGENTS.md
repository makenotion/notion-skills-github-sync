# AGENTS.md — Instructions for AI Agents

This file contains instructions for AI agents working with this repository.

## Setting Up config.json

If `config.json` is missing, the sync will fail. Follow this setup flow to create it.

### Step 1: Ensure Notion MCP is available

First, check that the Notion MCP server is installed and accessible. You'll need it to:
- Create databases (if the user doesn't have one)
- Resolve database IDs to data source IDs
- Query and update skills

If the Notion MCP isn't available, ask the user to add it to their agent's tools.

### Step 2: Create or use an existing skills database

**Default: Create a new skills database** (recommended for new setups)

Use the Notion MCP's `create-database` tool to create a new skills database:

```sql
CREATE TABLE "Skills" (
  "Skill name" title,
  "Description" rich_text,
  "Published" checkbox,
  "Created by" created_by
);
```

> **Note:** `Published` is a sync-specific property used as a gate for this tool—only
> rows with `Published` checked are synced to the marketplace. It's not part of the
> official Notion Skills typed DB schema, which only includes `Skill name`, `Description`,
> and `Created by`.

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

### Step 3: Optionally create a change requests database

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

### Step 4: Create config.json

Create a `config.json` file in the repository root:

```json
{
  "notionEnv": "dev",
  "skillsDataSourceId": "<from step 2>",
  "skillsDatabaseId": "<from step 2>",
  "changeRequestsDataSourceId": "<from step 3, or omit>",
  "githubRepo": "<owner/repo>",
  "githubBranch": "notion-sync",
  "pluginsDir": "plugins",
  "authorName": "notion-skills-sync",
  "authorEmail": "notion-skills-sync@users.noreply.github.com"
}
```

Required fields:
- `skillsDataSourceId` — the data source ID for the skills database
- `githubRepo` — target repository in `owner/repo` format

Optional fields (with defaults):
- `notionEnv` — Notion environment: `dev`, `stg`, or `prod` (default: `dev`)
- `skillsDatabaseId` — used by the `setup` command to add the Published property
- `changeRequestsDataSourceId` — enables "propose a change" feature
- `githubBranch` — branch to sync into (default: `notion-sync`)
- `pluginsDir` — where plugins are generated (default: `plugins`)
- `authorName` / `authorEmail` — commit author info

### Step 5: Run setup

After creating `config.json`, run the setup command to add the `Published`
checkbox property to the database (if it doesn't exist):

```bash
bun run setup
```

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
