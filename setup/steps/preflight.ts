import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandExists, loggedExec, openInBrowser } from "../exec.ts";
import { ensureNtnInstalled, probeNtnAuth } from "../ntn-cli.ts";
import { spinner } from "../spinner.ts";
import { abortWithHandoff } from "../handoff.ts";
import { notionPatSettingHelp } from "../guidance.ts";
import type { SetupLogger } from "../logger.ts";

export interface PreflightResult {
  /** GitHub username of the authenticated `gh` user. */
  ghUser: string;
  /** Organizations the user belongs to (for the skills-repo owner picker). */
  ghOrgs: string[];
}

/**
 * Workspace-level databases are private pages, so the Public API needs a
 * user-owned credential to own them. The CLI's personal access token appears
 * as a bot with a user owner; an internal connection is a workspace-owned bot
 * and cannot create a database at the top level.
 */
export function canCreateTopLevelNotionDatabase(stdout: string): boolean {
  try {
    const me = JSON.parse(stdout) as {
      type?: unknown;
      bot?: { owner?: { type?: unknown } };
    };
    return me.type === "person" || me.bot?.owner?.type === "user";
  } catch {
    return false;
  }
}

/** Extract the browser URL from the first half of `ntn login`. */
export function getNtnLoginUrl(stdout: string): string | null {
  return stdout.match(/https:\/\/[^\s]+/u)?.[0] ?? null;
}

/**
 * `ntn login` starts a device-style login flow and exits successfully before
 * credentials exist. The URL must be shown to the user and `ntn login poll`
 * must complete after they approve it in the browser.
 */
async function completeNtnLogin(
  logger: SetupLogger,
  notionEnv: string,
): Promise<{ code: number; stderr: string }> {
  const beginResult = await loggedExec(logger, "preflight", "ntn", [
    "--env", notionEnv, "login",
  ]);
  if (beginResult.code !== 0) {
    return { code: beginResult.code, stderr: beginResult.stderr };
  }

  const loginUrl = getNtnLoginUrl(beginResult.stdout);
  if (loginUrl) {
    p.log.info(`Complete Notion sign-in in your browser:\n  ${pc.cyan(loginUrl)}`);
    const opened = await openInBrowser(logger, "preflight", loginUrl);
    if (!opened) p.log.message(pc.dim(`If it did not open, use: ${loginUrl}`));
  } else {
    p.log.info(beginResult.stdout.trim());
  }

  const pollSpinner = spinner();
  pollSpinner.start("Waiting for Notion sign-in confirmation...");
  const pollResult = await loggedExec(logger, "preflight", "ntn", [
    "--env", notionEnv, "login", "poll",
  ]);
  pollSpinner.stop(
    pollResult.code === 0
      ? "Notion sign-in completed."
      : "Notion sign-in did not complete.",
  );
  return {
    code: pollResult.code,
    stderr: [beginResult.stderr, pollResult.stderr].filter(Boolean).join("\n"),
  };
}

/**
 * Phase 1: verify every tool setup itself needs — before asking the user
 * anything. The `ntn` and `gh` CLI logins here are setup tooling only; the
 * sync's own credentials are dedicated tokens created later, at the
 * access-tokens checkpoint.
 */
export async function stepPreflight(
  logger: SetupLogger,
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
  const installSpinner = spinner();
  const install = await ensureNtnInstalled(logger, "preflight", () =>
    installSpinner.start("Installing the Notion CLI (ntn)..."),
  );
  if (install.status === "failed") {
    installSpinner.stop("Failed to install ntn CLI.");
    p.log.error(`Could not install the Notion CLI.\n${pc.dim(install.stderr)}`);
    p.log.info(`Try installing manually: ${pc.cyan(install.command)}`);
    return null;
  }
  if (install.status === "installed") {
    installSpinner.stop("Notion CLI installed.");
  } else {
    p.log.success("Notion CLI (ntn) is installed.");
  }

  let authCheck = await probeNtnAuth(logger, "preflight", notionEnv);

  // `bun run` loads this repo's .env before setup starts. That file normally
  // contains the workspace-owned integration token used by the sync, and ntn
  // gives NOTION_API_TOKEN precedence over its own user-owned CLI login. If
  // that override cannot create a top-level database, remove it from this
  // setup process and retry the cached CLI credential before asking the user
  // to authenticate again. The .env file itself is untouched.
  if (
    process.env.NOTION_API_TOKEN &&
    (authCheck.code !== 0 || !canCreateTopLevelNotionDatabase(authCheck.stdout))
  ) {
    delete process.env.NOTION_API_TOKEN;
    logger.event("notion-env-token-ignored-for-setup");
    p.log.info(
      "Ignoring the environment's NOTION_API_TOKEN for database creation; " +
        "it is a sync connection, while setup needs your logged-in ntn user.",
    );
    authCheck = await probeNtnAuth(logger, "preflight", notionEnv);
  }

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

    const loginResult = await completeNtnLogin(logger, notionEnv);
    // Re-verify after the login poll so a blocked PAT policy gets an actionable
    // message rather than surfacing later as a database-creation failure.
    const reCheck = await probeNtnAuth(logger, "preflight", notionEnv);
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
    authCheck = reCheck;
    p.log.success("Authenticated with Notion.");
  }

  if (!canCreateTopLevelNotionDatabase(authCheck.stdout)) {
    p.log.warn(
      "The current Notion credential is a workspace-owned connection. It can read shared content, " +
        "but cannot create a top-level private database.",
    );
    p.log.info(
      "Setup needs a user-owned ntn login to create the database. The scheduled sync " +
        "still gets its own scoped connection later.",
    );
    const replaceCredential = await p.confirm({
      message: "Sign in with a personal access token now?",
      initialValue: true,
    });
    if (p.isCancel(replaceCredential) || !replaceCredential) {
      p.log.info(
        `To use a top-level database, run:\n` +
          `  ${pc.cyan(`unset NOTION_API_TOKEN && ntn --env ${notionEnv} logout && ntn --env ${notionEnv} login`)}\n` +
          `Then re-run: ${pc.cyan("bun run setup")}`,
      );
      return null;
    }

    // At this point there was no usable environment override or cached CLI
    // login. Clear the unusable cached credential before starting a fresh
    // personal login.
    const logoutResult = await loggedExec(logger, "preflight", "ntn", ["--env", notionEnv, "logout"]);
    if (logoutResult.code !== 0) {
      p.log.warn("Could not clear the existing Notion CLI credential; continuing with sign-in.");
    }
    const loginResult = await completeNtnLogin(logger, notionEnv);
    const reCheck = await probeNtnAuth(logger, "preflight", notionEnv);
    if (loginResult.code !== 0 || reCheck.code !== 0 || !canCreateTopLevelNotionDatabase(reCheck.stdout)) {
      logger.event("notion-top-level-auth-failed", {
        loginCode: loginResult.code,
        reCheckCode: reCheck.code,
      });
      p.log.error(
        "Notion authentication did not produce a user-owned credential for top-level database creation.",
      );
      p.log.info(
        `Unset any workspace connection token, then run:\n` +
          `  ${pc.cyan(`unset NOTION_API_TOKEN && ntn --env ${notionEnv} logout && ntn --env ${notionEnv} login`)}\n` +
          `Verify that bot.owner.type is \"user\" rather than \"workspace\":\n` +
          `  ${pc.cyan(`ntn --env ${notionEnv} api -X GET /v1/users/me`)}`,
      );
      return null;
    }
    authCheck = reCheck;
    p.log.success("Authenticated with a user-owned Notion credential.");
  }

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

  logger.event("preflight-complete", { ghUser, ghOrgs });
  return { ghUser, ghOrgs };
}
