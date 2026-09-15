# notion-skills-github-sync

This is a sample script showing a way to use the [Notion Skills API](https://developers.notion.com/guides/agent-skills/overview). The script syncs agent skills from Notion to a GitHub plugin marketplace; you can then connect the GitHub marketplace to agent apps such as ChatGPT and Claude which support importing skills from GitHub.

To use this script, you can fork it and deploy to your own GitHub Actions. It will on a schedule, making requests to the Skills API and loading the skills from Notion into the GitHub repo.


## Getting started

Clone this repo:

```bash
git clone git@github.com:makenotion/notion-skills-github-sync.git
cd notion-skills-github-sync
```

Run the setup command, which provides a guided step-by-step setup flow in a CLI:

```bash
bun install
bun run setup
```

## Setup process

Setup involves a few short steps that are mostly automatic:

1. **Checks** — checks that Notion and GitHub are installed and authenticated.
2. **Create resources** — creates a Notion Skills database with sample skills, plus two GitHub repositories: one to hold synced skills, and another to hold your own fork of this code.
3. **Add access tokens** — walks you through creating a scoped GitHub token and a Notion connection.
4. **Deploy and verify** — configures the scheduled GitHub Actions workflow and runs a test sync.
5. **Connect an agent app** *(optional)* — describes how to use the GitHub marketplace with Claude or ChatGPT/Codex.

**Note:** You may need administrator approvals or permissions in GitHub and Notion to create credentials. We recommend involving administrators with appropriate credentials when setting up this flow.

## Disclaimers

This code is provided as a sample, not a maintained product. You can modify it to meet your team's own needs.
