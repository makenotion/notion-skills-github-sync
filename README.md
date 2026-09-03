# notion-skills-github-sync

This is a script that uses the [Notion Agent Plugins API](https://developers.notion.com/guides/unreleased/agent-plugins/overview) to sync agent skills from Notion to a GitHub plugin marketplace. From there, you can optionally sync skills to agent apps that support loading plugins from GitHub.

It's useful if you want a collaborative way to manage your team's plugins that's designed for the whole team, not just engineers.

## Getting started

To use this script, you can fork it and deploy to your own GitHub Actions. It runs on a schedule, hitting the Plugins API and loading the skills from Notion into the GitHub repo. You own the code, so you are free to modify it to meet your team's needs.

To get started, clone this repo:

```bash
git clone git@github.com:makenotion/notion-skills-github-sync.git
cd notion-skills-github-sync
```

And then run the setup command which will guide you through step by step.

```bash
bun install
bun run setup
```

## Setup process

Setup involves a few short steps that are mostly automatic:

1. **Preflight** — checks that Notion and GitHub are installed and authenticated.
2. **Create resources** — creates a Notion Skills database with sample skills, plus two GitHub repositories: one to hold synced skills, and another to hold your own fork of this code.
3. **Add access tokens** — walks you through creating a scoped GitHub token and a Notion connection.
4. **Deploy and verify** — configures the scheduled GitHub Actions workflow and runs a test sync.
5. **Connect an agent app** *(optional)* — use the GitHub marketplace with Claude or ChatGPT/Codex.

**Note:** You may need administrator approvals or permissions in GitHub and Notion to create credentials.
