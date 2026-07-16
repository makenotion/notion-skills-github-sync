import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loggedExec, commandExists } from "../exec.ts";
import { spinner } from "../spinner.ts";
import { abortWithHandoff } from "../handoff.ts";
import { notionPatSettingHelp } from "../guidance.ts";
import type { WizardLogger } from "../logger.ts";
import { NOTION_API_VERSION } from "../../notion/ntn.ts";

export interface PreflightResult {
  /** GitHub username of the authenticated `gh` user. */
  ghUser: string;
  /** Organizations the user belongs to (for the skills-repo owner picker). */
  ghOrgs: string[];
  /** "owner/name" parsed from this checkout's origin remote, if it points at GitHub. */
  detectedOrigin: string | null;
}

function parseGithubRepo(remoteUrl: string): string | null {
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.\s]+)/);
  return match?.[1]?.replace(/\.git$/, "") ?? null;
}

/**
 * Phase 1: verify every tool the wizard itself needs — before asking the user
 * anything. The `ntn` and `gh` CLI logins here are wizard tooling only; the
 * sync's own credentials are dedicated tokens created later, at the
 * access-tokens checkpoint.
 */
export async function stepPreflight(
  logger: WizardLogger,
  notionEnv: string,
): Promise<PreflightResult | null> {
  p.log.step(pc.bold("Step 1 of 6: Preflight checks"));

  p.log.info(
    `First, let's make sure the tools we need are installed and signed in.`,
  );

  // The scheduled sync can only ever run if this checkout carries the workflow
  // file — fail here rather than after the user has answered questions.
  const workflowPath = join(process.cwd(), ".github", "workflows", "sync.yml");
  if (!existsSync(workflowPath)) {
    abortWithHandoff(logger, {
      step: "preflight checks",
      what:
        "No workflow file exists at .github/workflows/sync.yml, so the scheduled sync could never run. " +
        "Setup must be run from a full checkout of the sync tool.",
    });
  }

  // --- Notion CLI (ntn): install + auth ---
  const hasNtn = await commandExists("ntn");
  if (!hasNtn) {
    const installSpinner = spinner();
    installSpinner.start("Installing the Notion CLI (ntn)...");
    const installResult = await loggedExec(logger, "preflight", "bash", [
      "-c",
      "curl -fsSL https://ntn.dev | bash",
    ]);
    if (installResult.code !== 0) {
      installSpinner.stop("Failed to install ntn CLI.");
      p.log.error(
        `Could not install the Notion CLI.\n${pc.dim(installResult.stderr)}`,
      );
      p.log.info(
        `Try installing manually: ${pc.cyan("curl -fsSL https://ntn.dev | bash")}`,
      );
      return null;
    }
    installSpinner.stop("Notion CLI installed.");
  } else {
    p.log.success("Notion CLI (ntn) is installed.");
  }

  // `ntn whoami` doesn't exist in current versions, so probe the authenticated
  // `GET /v1/users/me` endpoint instead.
  const authCheck = await loggedExec(logger, "preflight", "ntn", [
    "--env", notionEnv,
    "api", "-X", "GET", "/v1/users/me",
    "--notion-version", NOTION_API_VERSION,
  ]);
  if (authCheck.code !== 0) {
    p.log.warn("The Notion CLI needs to be authenticated. Let's log in now.");
    p.log.info(
      `A browser window will open for Notion authentication.\n` +
        `${pc.dim("If you're in a terminal without browser access, you'll need to set NOTION_API_TOKEN instead.")}`,
    );

    const doLogin = await p.confirm({
      message: "Open browser to authenticate with Notion?",
      initialValue: true,
    });
    if (p.isCancel(doLogin) || !doLogin) {
      p.log.info(
        `You can authenticate later with: ${pc.cyan(`ntn --env ${notionEnv} login`)}`,
      );
      return null;
    }

    const loginResult = await loggedExec(logger, "preflight", "ntn", [
      "--env", notionEnv,
      "login",
    ]);
    // `ntn login` fails silently when the workspace restricts PATs — no browser,
    // no useful stderr. Re-verify auth and, if still broken, name the exact
    // admin setting rather than leaving the user staring at a dead prompt.
    const reCheck = await loggedExec(logger, "preflight", "ntn", [
      "--env", notionEnv,
      "api", "-X", "GET", "/v1/users/me",
      "--notion-version", NOTION_API_VERSION,
    ]);
    if (loginResult.code !== 0 || reCheck.code !== 0) {
      logger.event("notion-login-failed", {
        loginCode: loginResult.code,
        reCheckCode: reCheck.code,
      });
      p.log.error(
        `Notion authentication failed.` +
          (loginResult.stderr.trim() ? `\n${pc.dim(loginResult.stderr.trim())}` : ""),
      );
      p.log.warn(notionPatSettingHelp());
      return null;
    }
    p.log.success("Authenticated with Notion.");
  } else {
    let who = "";
    try {
      const me = JSON.parse(authCheck.stdout);
      who = me?.bot?.owner?.user?.name || me?.name || "";
    } catch { /* non-JSON output — just report success without a name */ }
    p.log.success(
      who
        ? `Authenticated with Notion as ${pc.cyan(who)}.`
        : "Authenticated with Notion.",
    );
  }

  // --- GitHub CLI (gh): install + auth ---
  const hasGh = await commandExists("gh");
  if (!hasGh) {
    p.log.error(
      `The GitHub CLI (${pc.cyan("gh")}) is not installed.\n` +
        `Install it from: ${pc.cyan("https://cli.github.com")}\n` +
        `Then run: ${pc.cyan("gh auth login")} and re-run this setup.`,
    );
    return null;
  }

  const authStatus = await loggedExec(logger, "preflight", "gh", [
    "auth",
    "status",
  ]);
  if (authStatus.code !== 0) {
    p.log.warn("The GitHub CLI is not authenticated.");
    p.log.info(
      `Run ${pc.cyan("gh auth login")} to authenticate, then re-run this setup.`,
    );
    return null;
  }

  // --- Gather context for the decisions phase ---
  const whoami = await loggedExec(logger, "preflight", "gh", [
    "api", "user", "--jq", ".login",
  ]);
  const ghUser = whoami.code === 0 ? whoami.stdout.trim() : "";
  p.log.success(
    ghUser
      ? `GitHub CLI is authenticated as ${pc.cyan(ghUser)}.`
      : "GitHub CLI is authenticated.",
  );

  const orgsResult = await loggedExec(logger, "preflight", "gh", [
    "api", "user/orgs", "--jq", ".[].login",
  ]);
  const ghOrgs =
    orgsResult.code === 0
      ? orgsResult.stdout.trim().split("\n").filter(Boolean)
      : [];

  const remoteResult = await loggedExec(logger, "preflight", "git", [
    "remote", "get-url", "origin",
  ]);
  const detectedOrigin =
    remoteResult.code === 0 ? parseGithubRepo(remoteResult.stdout) : null;

  logger.event("preflight-complete", { ghUser, ghOrgs, detectedOrigin });
  return { ghUser, ghOrgs, detectedOrigin };
}
