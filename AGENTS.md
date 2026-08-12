# AGENTS.md — Instructions for AI Agents

This file contains instructions for AI agents working with this repository.

## Configuring the sync

Configuration is **environment variables only** — `.env` for local runs, repo
variables + secrets for the scheduled workflow. There is no config file to
create. A leftover `config.json` is no longer read at all: the sync only
*detects* one, and fails with the variable name that replaced each key it still
sets so an old deployment can't silently run on ignored settings.

Follow this flow to configure a fresh deployment.

> **Communicating with users:** When showing the user what you've created or configured,
> always display **URLs** (e.g., `https://notion.so/workspace/abc123` or
> `https://github.com/my-org/my-skills`) rather than raw IDs. URLs are easier for users
> to recognize, click, and verify. The settings themselves use IDs internally.

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
connection is what controls publishing) and reports plugin grouping itself, so
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
`SKILLS_DATA_SOURCE_ID`. The database ID is in the response URL (`SKILLS_DATABASE_ID`).

**Alternative: Use an existing database**

If the user already has a skills database, ask them for the **database ID** (not the
data source ID). You can find it in the Notion URL, e.g.:
`https://notion.so/workspace/<database-id>?v=...`

Then use the `ntn` CLI to resolve it to a data source ID:

```bash
npx --yes ntn datasources resolve <database-id> --env dev --json
```

This returns the data source IDs for that database. Use the appropriate one as
`SKILLS_DATA_SOURCE_ID`.

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
per-row checkbox. Each skills plugin in the workspace becomes its own directory
under `plugins/`, named after the plugin (so a skill in the "Finance" plugin
lands in `plugins/finance/skills/<skill>/`).

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

Save its data source ID as `CHANGE_REQUESTS_DATA_SOURCE_ID`. This is optional —
leave it unset to disable the propose-a-change feature.

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

Use the resulting `owner/repo` (e.g., `my-org/notion-skills`) as `GITHUB_REPO`.

**Option B: Use an existing GitHub repository**

If you already have a repository you want to sync skills into, simply use its
`owner/repo` identifier. Make sure you have push access to the repository.

For example, if your repo URL is `https://github.com/my-org/my-skills`, then
`GITHUB_REPO=my-org/my-skills`.

### Step 6: Write the settings to `.env`

```bash
cat >> .env <<'EOF'
NOTION_API_TOKEN=<a Notion token with read access to the skills>
NOTION_ENV=prod
GITHUB_REPO=<from step 5>
GITHUB_BRANCH=main
SKILLS_DATABASE_ID=<from step 2>
SKILLS_DATA_SOURCE_ID=<from step 2>
CHANGE_REQUESTS_DATA_SOURCE_ID=<from step 4, or leave unset>
EOF
```

Required: `NOTION_API_TOKEN` and `GITHUB_REPO`. Everything else has a default —
see [`.env.example`](./.env.example) for the full list (`PLUGINS_DIR`,
`PLUGIN_SLUG`, `INJECT_UPDATER`, `GIT_AUTHOR_NAME`, …). The two
Notion ids are not used to read skills; they're recorded in each skill's
back-reference and in the updater's write-back guidance.

For the scheduled workflow, the same settings go on the repo the workflow runs
in — non-secrets as **variables**, tokens as **secrets**:

```bash
REPO=<owner>/<sync-script-repo>
gh variable set SKILLS_GITHUB_REPO --repo "$REPO" --body "<owner>/<skills-repo>"
gh variable set NOTION_ENV --repo "$REPO" --body prod
gh secret set NOTION_API_TOKEN --repo "$REPO"
gh secret set GH_PUSH_TOKEN --repo "$REPO"
```

`GITHUB_REPO` and `GITHUB_BRANCH` are stored as `SKILLS_GITHUB_*` because GitHub
refuses variable names starting with `GITHUB_`; the workflow maps them back.

### Step 7: Confirm the skills are visible to the API

The sync reads `GET /v1/ai/plugins` with `NOTION_API_TOKEN`. Two things
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

### Pulling tool updates

```bash
bun run update          # merge `upstream`, keeping local settings (.env) intact
```
