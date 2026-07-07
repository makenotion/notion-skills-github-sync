import * as p from "@clack/prompts";
import pc from "picocolors";
import { loggedExec, commandExists } from "../exec.ts";
import type { WizardLogger } from "../logger.ts";

export interface TokensResult {
  notionToken: string;
  githubToken: string;
  cachedNotionToken: boolean;
  cachedGithubToken: boolean;
}

export async function stepTokens(
  logger: WizardLogger,
  repo: string,
  databaseId: string,
): Promise<TokensResult | null> {
  p.log.step(pc.bold("Step 4: Set up authentication tokens"));

  p.log.info(
    `The sync script needs two tokens to bridge Notion and GitHub:\n` +
      `  1. A ${pc.cyan("Notion integration token")} — reads skills from your database\n` +
      `  2. A ${pc.green("GitHub personal access token")} — pushes plugins to the repo`,
  );

  // --- Notion token ---
  p.log.message(pc.bold("\nNotion integration token"));

  let notionToken = "";
  let cachedNotionToken = false;

  // Check if NOTION_API_TOKEN is already set in environment
  if (process.env.NOTION_API_TOKEN) {
    p.log.success("Found NOTION_API_TOKEN in your environment.");
    notionToken = process.env.NOTION_API_TOKEN;
    cachedNotionToken = true;
  } else {
    // Check if ntn has a cached token
    const ntnToken = await loggedExec(logger, "tokens", "ntn", [
      "--env",
      "dev",
      "token",
    ]);
    if (ntnToken.code === 0 && ntnToken.stdout.trim()) {
      p.log.success("Found a cached Notion token from the CLI.");
      notionToken = ntnToken.stdout.trim();
      cachedNotionToken = true;
    }
  }

  if (!notionToken) {
    p.log.info(
      `To create a Notion integration token:\n` +
        `  1. Go to ${pc.cyan("https://www.notion.so/my-integrations")}\n` +
        `  2. Click ${pc.bold("\"New integration\"")}\n` +
        `  3. Name it something like "Skills Sync"\n` +
        `  4. Under Capabilities, enable ${pc.bold("Read content")} and ${pc.bold("Read user information")}\n` +
        `  5. Copy the Internal Integration Token`,
    );

    const tokenInput = await p.password({
      message: "Paste your Notion integration token (starts with ntn_ or secret_):",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "Token cannot be empty";
        if (!v.startsWith("ntn_") && !v.startsWith("secret_"))
          return "Token should start with ntn_ or secret_";
        return undefined;
      },
    });
    if (p.isCancel(tokenInput)) return null;
    notionToken = String(tokenInput).trim();
  }

  // Remind about connecting the integration to the database
  p.log.warn(
    `${pc.bold("Important:")} You must connect this integration to your skills database.\n` +
      `  1. Open your skills database in Notion\n` +
      `  2. Click ${pc.bold("···")} (menu) → ${pc.bold("Connections")} → ${pc.bold("Connect to")}\n` +
      `  3. Select your "Skills Sync" integration\n\n` +
      `${pc.dim("Without this step, the sync script won't be able to read your skills.")}`,
  );

  const connected = await p.confirm({
    message: "Have you connected the integration to the database?",
    initialValue: false,
  });
  if (p.isCancel(connected)) return null;
  if (!connected) {
    p.log.info(
      `No problem — you can connect it later. The sync script will fail until it's connected, ` +
        `but it won't break anything.`,
    );
  }

  // --- GitHub token ---
  p.log.message(pc.bold("\nGitHub personal access token"));

  let githubToken = "";
  let cachedGithubToken = false;

  // Check if GITHUB_TOKEN is already set
  if (process.env.GITHUB_TOKEN) {
    p.log.success("Found GITHUB_TOKEN in your environment.");
    githubToken = process.env.GITHUB_TOKEN;
    cachedGithubToken = true;
  } else if (process.env.GH_PUSH_TOKEN) {
    p.log.success("Found GH_PUSH_TOKEN in your environment.");
    githubToken = process.env.GH_PUSH_TOKEN;
    cachedGithubToken = true;
  } else {
    // Try gh auth token
    const ghToken = await loggedExec(logger, "tokens", "gh", [
      "auth",
      "token",
    ]);
    if (ghToken.code === 0 && ghToken.stdout.trim()) {
      const useGhToken = await p.confirm({
        message: `Use your current GitHub CLI token for the sync? (may have limited scope)`,
        initialValue: true,
      });
      if (p.isCancel(useGhToken)) return null;
      if (useGhToken) {
        githubToken = ghToken.stdout.trim();
        cachedGithubToken = true;
      }
    }
  }

  if (!githubToken) {
    p.log.info(
      `To create a GitHub personal access token:\n` +
        `  1. Go to ${pc.cyan("https://github.com/settings/tokens?type=beta")}\n` +
        `  2. Click ${pc.bold("\"Generate new token\"")}\n` +
        `  3. Name: "Notion Skills Sync"\n` +
        `  4. Repository access: select ${pc.bold(repo)}\n` +
        `  5. Permissions: Contents → ${pc.bold("Read and write")}\n` +
        `  6. Click "Generate token" and copy it`,
    );

    const ghTokenInput = await p.password({
      message: "Paste your GitHub personal access token:",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "Token cannot be empty";
        return undefined;
      },
    });
    if (p.isCancel(ghTokenInput)) return null;
    githubToken = String(ghTokenInput).trim();
  }

  // Validate the GitHub token can access the repo
  const validateSpinner = p.spinner();
  validateSpinner.start("Validating GitHub token...");

  const validateResult = await loggedExec(logger, "tokens", "gh", [
    "api",
    `repos/${repo}`,
    "--jq",
    ".permissions.push",
  ], {
    env: { GH_TOKEN: githubToken },
  });

  if (validateResult.code !== 0 || validateResult.stdout.trim() !== "true") {
    validateSpinner.stop("Token validation issue.");
    p.log.warn(
      `Could not confirm push access to ${pc.cyan(repo)}.\n` +
        `The token may still work — we'll verify during the test sync.\n` +
        `${pc.dim("Make sure the token has Contents: Read and write permission.")}`,
    );
  } else {
    validateSpinner.stop("GitHub token validated — push access confirmed.");
  }

  p.log.success("Authentication tokens ready.");

  return {
    notionToken,
    githubToken,
    cachedNotionToken,
    cachedGithubToken,
  };
}
