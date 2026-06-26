# AGENTS.md — Instructions for AI Agents

This file contains instructions for AI agents working with this repository.

## Setting Up config.json

If the `config.json` file is missing, the sync will fail with an error about
missing `dataSourceId`. You need to set up this file before the tool can work.

### Step 1: Ask the user for data source IDs

Ask the user to provide the following:

1. **Skills data source ID** — The data source ID for the skills database (not
   the database ID). This is a UUID like `f66a7cde-a6b9-4b5d-8bf1-4e3bfe15050d`.

2. **Change requests data source ID** (optional) — The data source ID for the
   change requests database. When set, the injected updater skill offers to file
   a change request for review instead of editing the skill directly.

### Step 2: Create the databases if needed

If the user doesn't have existing databases, you can create them using the
Notion MCP's `create-database` tool:

```sql
-- Skills database schema
CREATE TABLE "Skills" (
  "Skill name" title,
  "Description" text,
  "Published" checkbox DEFAULT false,
  "Version" number DEFAULT 1.0,
  "Author" rich_text
);
```

```sql
-- Change requests database schema (optional)
CREATE TABLE "Change Requests" (
  "Name" title,
  "Status" status DEFAULT 'Proposed',
  "Skill" relation("Skills"),
  "Context" rich_text
);
```

After creating the databases, get the data source IDs from the response (they
appear in the `<data-source>` tag) or use the ntn CLI:

```bash
npx --yes ntn datasources resolve <database-id> --env dev
```

### Step 3: Create config.json

Create a `config.json` file in the repository root with the following structure:

```json
{
  "dataSourceId": "<skills data source id>",
  "databaseId": "<skills database id>",
  "changeRequestsDataSourceId": "<change requests data source id>"
}
```

- `dataSourceId` (required): The data source ID for skills
- `databaseId` (optional): The database ID, used only by the `setup` command
- `changeRequestsDataSourceId` (optional): Enables "propose a change" feature

### Step 4: Run setup

After creating `config.json`, run the setup command to add the `Published`
checkbox property to the database:

```bash
bun run setup
```

### Environment Variables (CI/CD)

In CI environments (like GitHub Actions), you can use environment variables
instead of `config.json`:

- `NOTION_DATA_SOURCE_ID` — Skills data source ID
- `NOTION_DATABASE_ID` — Skills database ID  
- `NOTION_CHANGE_REQUESTS_DATA_SOURCE_ID` — Change requests data source ID

The tool checks `config.json` first, then falls back to environment variables.

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
