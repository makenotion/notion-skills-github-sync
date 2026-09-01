# notion-skills-github-sync

This is a script that uses the [Notion Agent Plugins API](https://developers.notion.com/guides/unreleased/agent-plugins/overview) to sync agent skills from Notion to a GitHub plugin marketplace. From there, you can sync skills to Claude Cowork, or to other agents that support loading plugins from GitHub.

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

**Note:** To complete setup, you'll need to create auth tokens in both Notion and GitHub. You may need to ask for help from an administrator in either of those services to set this up.
