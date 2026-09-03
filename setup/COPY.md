# Setup copy

This is the editable copy deck for `bun run setup`. Curly-brace values such as `{skills_repo}` are filled in at runtime. The source file for each section is shown so approved edits can be applied without searching through concatenated strings.

> This is a copy inventory, not a runtime template: editing it does not yet change the CLI. It is the single clean document for reviewing and editing all setup wording.

## Welcome

_Source: `setup/steps/welcome.ts`_

**Title:** Notion Skills → GitHub Sync

**How it works:**

```text
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ Notion Skills│ ───▶ │ GitHub repo  │ ───▶ │  Agent app   │
│ DB           │      │              │      |              |
└──────────────┘      └──────────────┘      └──────────────┘
```

You're setting up a script that syncs agent skills from Notion to a GitHub repo. From there, you can sync to your chosen agent apps.

This lets you store your skills in a collaborative library that's accessible to your whole team, not just engineers who know how to use GitHub.

To complete setup, you'll need access to create authentication tokens in Notion and GitHub.

**Prompt:** Ready to begin?

**Cancellation:** Setup cancelled. Run this command again when you're ready.

## Step 1 of 6 — Preflight checks

_Sources: `setup/steps/preflight.ts`, `setup/guidance.ts`_

First, let's make sure the tools we need are installed and signed in.

### Notion CLI

- Installing the Notion CLI (ntn)...
- Failed to install ntn CLI.
- Could not install the Notion CLI.
- Try installing manually: `{install_command}`
- Notion CLI installed.
- Notion CLI (ntn) is installed.
- Ignoring the environment's NOTION_API_TOKEN for database creation; it is a sync
  connection, while setup needs your logged-in ntn user.
- The Notion CLI needs to be authenticated. Let's log in now.

A browser window will open for Notion authentication. Complete the sign-in there;
setup waits for the confirmation before it continues.

If you're in a terminal without browser access, you'll need to set `NOTION_API_TOKEN` instead.

**Prompt:** Open browser to authenticate with Notion?

**If skipped:** You can authenticate later with: `ntn --env {notion_env} login`

**Success:** Authenticated with Notion as `{name}`.

**Fallback success:** Authenticated with Notion.

### Notion PAT help

If no browser opened and no clear error appeared, a Notion workspace admin setting is likely blocking personal access tokens. To fix:

- Open settings
- Go to Connections > Manage
- Update "Limit who can create personal access tokens (PATs)" to "All workspace members"

### GitHub CLI

The GitHub CLI (`gh`) is not installed.

Install it from: https://cli.github.com

Then run: `gh auth login` and re-run this setup.

The GitHub CLI is not authenticated.

Run `gh auth login` to authenticate, then re-run this setup.

**Success:** GitHub CLI is authenticated as `{github_user}`.

**Fallback success:** GitHub CLI is authenticated.

## Step 2 of 6 — A few decisions

_Source: `setup/steps/decisions.ts`_

Let's start by confirming some decisions about your setup.

### Skills repo

**Prompt:** Skills repo owner

- `{organization}` — organization (recommended for teams)
- `{github_user}` — personal account

**Prompt if no accounts are found:** Skills repo owner (user or organization)

**Prompt:** Skills repo name

**Default:** `notion-skills`

**Validation:** Name cannot be empty

**Validation:** Invalid repo name (use letters, numbers, hyphens, dots, underscores)

### Sync script repo

We will also create a repo to host your own fork of this code.
This repo will be where the hourly GitHub Actions workflow runs.

**Prompt:** Sync script repo owner

**Prompt:** Sync script repo name

**Default:** `notion-skills-github-sync`

### Plan summary

Here's what we'll do:

1. Create the Notion Skills DB “{database_name}” with sample skills.
2. Create the skills repo `{skills_repo}`.
3. Create the sync script repo `{sync_repo}`.
4. Create two access tokens for GitHub and Notion.
5. Push the sync script and initiate the GitHub Actions workflow.
6. Run a test sync.
7. **Test run only:** At the end, help you delete the GitHub repos created above.

**Prompt:** Proceed?

## Step 3 of 6 — Creating your resources

_Source: `setup/steps/resources.ts`_

Now we'll create your database and repos — this only takes a few seconds.

### Notion Skills DB

- Creating the Notion Skills DB (“{database_name}”)...
- Failed to create the Notion Skills DB.
- Notion Skills DB created: `{database_url}`
- Adding sample skills...
- Added `{created}/{total}` sample skills.
- Some sample skills failed to create. You can add skills manually later.
- A sample skill's bundled files (zip attachment) could not be uploaded — the skill was created without them.

### Skills repo

- Creating the skills repo `{skills_repo}`...
- Failed to create the skills repo.
- Skills repo created: `{skills_repo_url}`
- Could not create the skills repo's initial commit. The sync will handle this, but the first run may need the repo to have at least one commit.

### Sync script repo

- Creating the sync script repo `{sync_repo}` (private)...
- Failed to create the sync script repo.
- Repo created, but could not set the origin remote.
- Sync script repo ready: `{sync_repo}` (previous origin kept as `upstream`).

## Step 4 of 6 — Access tokens

_Sources: `setup/steps/credentials.ts`, `setup/guidance.ts`_

Now you'll need to create two access tokens:

- a **GitHub PAT** to push to the skills repo
- a **Notion access token** to read skills from Notion

### GitHub fine-grained PAT

You'll see a GitHub PAT creation page. Once you're there:

1. Under **Repository access**, choose **Only select repositories** → pick `{skills_repo}`.
2. Click **Generate token** and copy it.

**Prompt:** Open the GitHub token page in your browser?

**If the page doesn't open:** `{github_pat_url}`

**Prompt:** Paste the GitHub token

**Validation:** Token cannot be empty

- Checking push access to `{skills_repo}`...
- GitHub token verified — push access to the skills repo confirmed.
- Could not confirm push access with that token.

The token can't push to `{skills_repo}`. Usually this means the repo wasn't selected under “Repository access”, the Contents permission isn't Read and write, or (in an org) the token is still awaiting admin approval: Organization Settings → Personal access tokens → Pending requests.

**Prompt:** How do you want to proceed?

- Paste a token again — fix the token settings first
- Continue anyway — the test sync will fail if it really can't push

#### GitHub PAT approval help

If your `{organization}` organization requires approval for fine-grained tokens, the token won't work until a GitHub org admin approves it:

- Location: Organization Settings → Personal access tokens → Pending requests

This token is scoped to only the `{skills_repo}` repository (Contents: read/write).

### Notion access token

Now create a Notion connection — we'll open the connections page:

1. Click **New connection**.
2. Set the name (for example, “Skills Sync”).
3. Select **Access token** as the authentication method
4. Select your workspace
5. Click "Create connection"
3. Copy the **Access token** once created.

**Prompt:** Open the Notion connections page in your browser?

**If the page doesn't open:** `{notion_integrations_url}`

**Prompt:** Paste the Notion access token

**Validation:** Token cannot be empty

**Validation:** Token should start with `ntn_`, `secret_`, or `development_ntn_`

#### Notion connection help

If you can't create the connection or its access token, a Notion workspace admin setting is likely blocking internal connections. You'll need to have an admin follow the steps above to create a token for you.

### Connect the Notion connection to the database

Last manual step — authorize the token to read your Notion Skills DB (we'll open it in the browser):

1. Click **···** (top-right menu) → **Connections** → **Add connection**.
2. Select “Skills Sync”.

Without this, the access token can't see the database.

**Prompt:** Open the Notion Skills DB in your browser?

**If the page doesn't open:** Add the connection here: `{database_url}`

- Waiting for the “Skills Sync” connection on “{database_name}”... (add it in Notion now)
- Connection detected — the token can read the Notion Skills DB.
- Connection not detected yet.

**Prompt:** Still can't read the database with that token. What now?

- Keep waiting — finish adding the connection in Notion
- Continue anyway — the sync will fail until the connection is added

**If skipped:** Continuing without a verified connection. The test sync will fail unless the connection is added to the database.

**Success:** Access tokens ready.

## Step 5 of 6 — Deploy and verify

_Source: `setup/steps/deploy.ts`_

Time to deploy and verify everything — no more questions from here; sit back and watch.

- Writing `.env`...
- `.env` written (`{written_count}` setting(s), `{skipped_count}` already set and left alone).
- Pushing the sync script repo to `{sync_repo}:{branch}`...
- Push failed.
- Pushed to `{sync_repo}:{branch}` — the workflow is now on GitHub.
- Setting the two secrets on `{sync_repo}`...
- Setting secrets failed.
- Secrets stored (encrypted) on `{sync_repo}`: `NOTION_API_TOKEN`, `GH_PUSH_TOKEN`.
- Setting the sync settings as variables on `{sync_repo}`...
- Setting variables failed.
- Variables stored on `{sync_repo}`: `{variable_names}`.
- Dry-run failed.
- Dry-run succeeded.
- Sync failed.
- Sync completed successfully!
- Idempotency check passed — no unnecessary commits.
- Note: re-run produced changes (may be expected on first setup).

### GitHub Actions verification

- Waiting for GitHub to register the workflow...
- Workflow never registered.
- Workflow registered with GitHub.
- Dispatching the sync workflow...
- Could not dispatch the workflow.
- Workflow dispatched.
- Waiting for the run to start...
- Run did not appear in time.
- Run started (id `{run_id}`).
- Watching the run (usually 1–2 minutes)...
- GitHub Actions run failed.
- GitHub Actions run passed!

The production path works end to end: the workflow read Notion, and pushed (or confirmed “Up to date”) on the skills repo. It will now run hourly on its own.

## Step 6 of 6 — Connect to agent apps (optional)

_Source: `setup/steps/wrapup.ts`_

The sync is live! Your GitHub repo now contains your skills.

**Prompt:** Would you like to sync your GitHub repo to an agent app now?

**If yes — multi-select:** Which agent apps would you like to connect?

- Claude — Follow the GitHub marketplace instructions: https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization#h_ae90e57fb6
- ChatGPT/Codex — Follow the GitHub marketplace instructions: https://help.openai.com/en/articles/20001504-importing-and-syncing-plugin-marketplaces-from-github

**If skipped:** No problem — you can connect this GitHub repo to an agent app anytime.

### Completion summary

**You're all set**

- **Notion Skills DB:** `{database_url}`
- **Skills repo:** `{skills_repo_url}`
- **Sync script repo:** `https://github.com/{sync_repo}`

Team members just write skills in Notion — there's no checkbox to tick. The sync picks them up within the hour and publishes them to GitHub. What syncs is whatever the Notion connection can read, so scope the connection to control what gets published.

Setup log: `{log_path}`

**Prompt:** Open your Notion Skills DB in the browser? (`{database_url}`)

**Outro:** Happy syncing! Your team's knowledge now flows from Notion → GitHub automatically.

## Test run — Clean up

_Source: `setup/steps/cleanup.ts`_

This was a test run — let's delete the GitHub repos the setup created. Everything above ran for real, so until they're deleted the hourly sync workflow stays live.

**Not cleaned up automatically:**

- The Notion Skills DB “{database_name}” — trash it in Notion if you're done: `{database_url}`
- Your local `.env` still holds this run's settings and tokens.

**Prompt:** Delete the {skills or sync script} repo `{repo}`?

- Keeping `{repo}`.
- Deleting `{repo}`...
- Deleted `{repo}`.
- Could not delete `{repo}`.

Your `gh` login is missing the **delete_repo** scope. In another terminal, run `gh auth refresh -h github.com -s delete_repo`, then pick “Try again” here.

**Prompt:** What now for `{repo}`?

- Try again
- Skip — I'll delete it manually: `https://github.com/{repo}/settings`

**If skipped:** Delete it at `https://github.com/{repo}/settings` when ready.

- Local git remotes restored: the previous origin (kept as `upstream`) is `origin` again.
- Removed the `origin` remote (it pointed at the deleted repo).

**Outro:** Test run cleanup finished.

## Failure and recovery

_Sources: `setup/index.ts`, `setup/handoff.ts`_

### Generic cancellation

Setup cancelled. Run this command again when you're ready.

### Unexpected crash

Setup crashed unexpectedly: `{error_message}`

Full diagnostic log written to: `{log_path}`

### Guided failure handoff

**Setup failed at:** `{step}`

`{what_went_wrong}`

To investigate, paste this prompt into a coding agent (for example, `claude`) started in this directory:

```text
My `bun run setup` for notion-skills-github-sync failed at the "{step}" step: {what_went_wrong} Read the setup log at {log_path} — it's JSONL, one command/event record per line (secrets redacted) — to find the failing command and its stderr, and look at the relevant code in setup/steps/. Diagnose the root cause, fix it or give me the exact commands to run, then tell me to re-run `bun run setup`.
```

Setup log: `{log_path}`
