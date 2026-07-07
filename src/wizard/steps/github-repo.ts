import * as p from "@clack/prompts";
import pc from "picocolors";
import { loggedExec, commandExists } from "../exec.ts";
import { spinner } from "../spinner.ts";
import type { WizardLogger } from "../logger.ts";

export interface GithubRepoResult {
  repo: string; // "owner/name"
  repoUrl: string;
}

export async function stepCreateGithubRepo(
  logger: WizardLogger,
): Promise<GithubRepoResult | null> {
  p.log.step(pc.bold("Step 3: Create the target GitHub repository"));

  p.log.info(
    `The sync script publishes skills as plugins to a GitHub repository.\n` +
      `This repo is a hidden implementation detail — your team never interacts with it directly.`,
  );

  // Check if gh CLI is available
  const hasGh = await commandExists("gh");
  if (!hasGh) {
    p.log.error(
      `The GitHub CLI (${pc.cyan("gh")}) is not installed.\n` +
        `Install it from: ${pc.cyan("https://cli.github.com")}\n` +
        `Then run: ${pc.cyan("gh auth login")}`,
    );
    return null;
  }

  // Check if gh is authenticated
  const authStatus = await loggedExec(logger, "github-repo", "gh", [
    "auth",
    "status",
  ]);
  if (authStatus.code !== 0) {
    p.log.warn("The GitHub CLI is not authenticated.");
    p.log.info(`Run ${pc.cyan("gh auth login")} to authenticate, then re-run this wizard.`);
    return null;
  }
  p.log.success("GitHub CLI is authenticated.");

  // Get the current user
  const whoami = await loggedExec(logger, "github-repo", "gh", [
    "api",
    "user",
    "--jq",
    ".login",
  ]);
  const currentUser = whoami.stdout.trim();

  // Get user's organizations for the owner picker
  const orgsResult = await loggedExec(logger, "github-repo", "gh", [
    "api",
    "user/orgs",
    "--jq",
    ".[].login",
  ]);
  const orgs = orgsResult.code === 0
    ? orgsResult.stdout.trim().split("\n").filter(Boolean)
    : [];

  const repoChoice = await p.select({
    message: "Create a new repo or use an existing one?",
    options: [
      { value: "new", label: "Create a new repository (recommended)" },
      { value: "existing", label: "Use an existing repository" },
    ],
  });

  if (p.isCancel(repoChoice)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  if (repoChoice === "existing") {
    const repoInput = await p.text({
      message: "Enter the repository (owner/name format):",
      placeholder: `${currentUser}/notion-skills`,
      validate: (v) => {
        if (!v || !v.includes("/")) return "Must be in owner/name format";
        if (v.trim().length < 3) return "Repository name too short";
        return undefined;
      },
    });
    if (p.isCancel(repoInput)) return null;
    const repo = String(repoInput).trim();
    return {
      repo,
      repoUrl: `https://github.com/${repo}`,
    };
  }

  // Owner picker: show user + orgs as a select
  const ownerOptions: Array<{ value: string; label: string; hint?: string }> = [];
  if (currentUser) {
    ownerOptions.push({ value: currentUser, label: currentUser, hint: "personal account" });
  }
  for (const org of orgs) {
    ownerOptions.push({ value: org, label: org, hint: "organization" });
  }

  let owner: string;
  if (ownerOptions.length > 1) {
    const ownerChoice = await p.select({
      message: "Repository owner:",
      options: ownerOptions,
    });
    if (p.isCancel(ownerChoice)) return null;
    owner = String(ownerChoice);
  } else {
    owner = currentUser || "";
    if (!owner) {
      const ownerInput = await p.text({
        message: "Repository owner (user or organization):",
      });
      if (p.isCancel(ownerInput)) return null;
      owner = String(ownerInput).trim();
    }
  }

  const repoName = await p.text({
    message: "Repository name:",
    initialValue: "notion-skills",
    validate: (v) => {
      if (!v || v.trim().length === 0) return "Name cannot be empty";
      if (!/^[a-zA-Z0-9._-]+$/.test(v.trim()))
        return "Invalid repo name (use letters, numbers, hyphens, dots, underscores)";
      return undefined;
    },
  });
  if (p.isCancel(repoName)) return null;

  const visibility = await p.select({
    message: "Repository visibility:",
    options: [
      { value: "private", label: "Private (recommended)" },
      { value: "public", label: "Public" },
    ],
  });
  if (p.isCancel(visibility)) return null;

  const name = String(repoName).trim();
  const repo = `${owner}/${name}`;
  const repoUrl = `https://github.com/${repo}`;

  const createSpinner = spinner();
  createSpinner.start(`Creating ${pc.cyan(repo)}...`);

  const createResult = await loggedExec(logger, "github-repo", "gh", [
    "repo",
    "create",
    repo,
    `--${String(visibility)}`,
    "--description",
    "Skills marketplace synced from Notion",
  ]);

  if (createResult.code !== 0) {
    createSpinner.stop("Failed to create repository.");
    if (createResult.stderr.includes("already exists")) {
      p.log.warn(`Repository ${pc.cyan(repo)} already exists. Using it.`);
    } else {
      p.log.error(
        `Could not create the repository.\n${pc.dim(createResult.stderr)}`,
      );
      return null;
    }
  } else {
    createSpinner.stop(`Repository created: ${pc.cyan(repoUrl)}`);
  }

  // Initialize the repo with an empty commit so sync has a base
  const initSpinner = spinner();
  initSpinner.start("Initializing repository with an empty commit...");

  const initResult = await loggedExec(logger, "github-repo", "gh", [
    "api",
    `repos/${repo}/contents/README.md`,
    "-X",
    "PUT",
    "-f",
    "message=Initial commit",
    "-f",
    `content=${Buffer.from(`# ${name}\n\nSkills marketplace synced from Notion.\n`).toString("base64")}`,
  ]);

  if (initResult.code !== 0) {
    if (!initResult.stderr.includes("already exists") && !initResult.stderr.includes("Invalid request")) {
      initSpinner.stop("Note: could not initialize repo.");
      p.log.warn(
        `Could not create initial commit. The sync will handle this, but the first run may need ` +
          `the repo to have at least one commit.`,
      );
    } else {
      initSpinner.stop("Repository already has content.");
    }
  } else {
    initSpinner.stop("Repository initialized.");
  }

  p.log.success(
    `GitHub repo ready: ${pc.cyan(repoUrl)}\n` +
      `${pc.dim("The sync script will push plugins here on a schedule.")}`,
  );

  return { repo, repoUrl };
}
