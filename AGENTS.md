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

### Step 4: Choose or create a target GitHub repository

The sync tool publishes skills to a GitHub repository. You have two options:

**Option A: Create a new GitHub repository** (recommended for new setups)

Use the GitHub CLI to create a new repository that will serve as your skills
marketplace:

```bash
gh repo create <owner>/<repo-name> --public --description "Skills marketplace synced from Notion"
```

For example:
```bash
gh repo create my-org/notion-skills --public --description "Skills marketplace synced from Notion"
```

This creates a fresh repo ready to receive synced skills. Use the resulting
`<owner>/<repo-name>` as your `githubRepo` value in config.json.

**Option B: Use an existing GitHub repository**

If you already have a repository you want to sync skills into, simply use its
`owner/repo` identifier. Make sure you have push access to the repository.

For example, if your repo URL is `https://github.com/my-org/my-skills`, your
`githubRepo` value would be `my-org/my-skills`.

### Step 5: Create config.json

Create a `config.json` file in the repository root:

```json
{
  "notionEnv": "prod",
  "skillsDataSourceId": "<from step 2>",
  "skillsDatabaseId": "<from step 2>",
  "changeRequestsDataSourceId": "<from step 3, or omit>",
  "githubRepo": "<from step 4>",
  "githubBranch": "main",
  "pluginsDir": "plugins",
  "authorName": "notion-skills-sync",
  "authorEmail": "notion-skills-sync@users.noreply.github.com"
}
```

Required fields:
- `skillsDataSourceId` — the data source ID for the skills database
- `githubRepo` — target repository in `owner/repo` format

Optional fields (with defaults):
- `notionEnv` — Notion environment: `dev`, `stg`, or `prod` (default: `prod`)
- `skillsDatabaseId` — used by the `setup` command to add the Published property
- `changeRequestsDataSourceId` — enables "propose a change" feature
- `githubBranch` — branch to sync into (default: `main`)
- `pluginsDir` — where plugins are generated (default: `plugins`)
- `authorName` / `authorEmail` — commit author info

### Step 6: Run setup

After creating `config.json`, run the setup command to add the `Published`
checkbox property to the database (if it doesn't exist):

```bash
bun run setup
```

### What's next?

After setup completes, you're ready to sync! Here are the key resources:

**Your resources:**
- **Notion database:** `https://notion.so/<workspace>/<skillsDatabaseId>` — this is where you'll manage your skills
- **GitHub repository:** `https://github.com/<githubRepo>` — this is where synced skills are published

**Run your first sync:**
```bash
bun run dry-run  # Preview what would be synced (no changes made)
bun run sync     # Sync skills to GitHub
```

**Set up automated syncing (recommended):**

To keep your GitHub marketplace in sync automatically, set up the GitHub Action.
This runs hourly and on-demand.

1. Go to your sync repository's **Settings > Secrets and variables > Actions**
2. Add these secrets:
   - `NOTION_API_TOKEN` — your Notion API token (must have read access to the skills database)
   - `GH_PUSH_TOKEN` — a GitHub PAT with `contents:write` permission on the target repo
3. The workflow at `.github/workflows/sync.yml` will now run hourly

You can also trigger a sync manually from **Actions > Sync Notion skills > Run workflow**.

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
