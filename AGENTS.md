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

> **Installing the `ntn` CLI:** If you need to use the `ntn` CLI and it's not already
> installed, run:
> ```bash
> curl -fsSL https://ntn.dev | bash
> ```
> This installs `ntn` to `/usr/local/bin`. Alternatively, use `npx --yes ntn <command>`
> to run it without a permanent install.

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

For each skill, fill in the `Skill name`, `Description`, and skill body content,
then check the `Published` checkbox to include it in the marketplace sync.

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
  "skillsDatabaseUrl": "https://notion.so/workspace/<database-id>?v=...",
  "changeRequestsDataSourceId": "<from step 3, or omit>",
  "githubRepo": "https://github.com/<owner>/<repo-name>",
  "githubBranch": "main",
  "pluginsDir": "plugins",
  "authorName": "notion-skills-sync",
  "authorEmail": "notion-skills-sync@users.noreply.github.com"
}
```

Required fields:
- `skillsDataSourceId` — the data source ID for the skills database
- `githubRepo` — target repository URL (e.g., `https://github.com/my-org/notion-skills`)

Optional fields (with defaults):
- `notionEnv` — Notion environment: `dev`, `stg`, or `prod` (default: `prod`)
- `skillsDatabaseUrl` — URL to the skills database in Notion (for reference)
- `changeRequestsDataSourceId` — enables "propose a change" feature
- `githubBranch` — branch to sync into (default: `main`)
- `pluginsDir` — where plugins are generated (default: `plugins`)
- `authorName` / `authorEmail` — commit author info

### Step 7: Run setup

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
