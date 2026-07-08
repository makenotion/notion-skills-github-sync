import * as p from "@clack/prompts";
import pc from "picocolors";
import { loggedExec, openInBrowser } from "../exec.ts";
import { spinner } from "../spinner.ts";
import { tokenCanReadDataSource } from "../skills-db.ts";
import type { WizardLogger } from "../logger.ts";

export interface Credentials {
  notionToken: string;
  githubToken: string;
}

export const PAT_EXPIRES_IN_DAYS = 366;

/**
 * Build the pre-filled fine-grained-PAT creation URL. GitHub supports
 * name/description/owner/expiry/permissions as query params — the one thing it
 * can't pre-fill is the repository selection, which is why this step runs
 * after the skills repo exists.
 * https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters
 */
export function buildPatUrl(skillsRepo: string): string {
  const owner = skillsRepo.split("/")[0] ?? "";
  const params = new URLSearchParams({
    name: "Notion Skills Sync",
    description: `Pushes synced skill plugins to ${skillsRepo}`,
    target_name: owner,
    expires_in: String(PAT_EXPIRES_IN_DAYS),
    contents: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

function myIntegrationsUrl(notionEnv: string): string {
  const host = notionEnv === "prod" ? "www.notion.so" : `${notionEnv}.notion.so`;
  return `https://${host}/my-integrations`;
}

interface CredentialsInput {
  skillsRepo: string; // "owner/name"
  dataSourceId: string;
  databaseUrl: string;
  dbName: string;
}

/**
 * Phase 4: the single manual checkpoint. Both dedicated tokens are created by
 * the user in the browser — deliberately NOT the cached `gh`/`ntn` CLI
 * credentials, which are account-wide. Each token is scoped to exactly one
 * resource that now exists: the PAT to the skills repo, the Notion integration
 * to the Notion Skills DB. Both are verified before the wizard moves on.
 */
export async function stepCredentials(
  logger: WizardLogger,
  notionEnv: string,
  input: CredentialsInput,
): Promise<Credentials | null> {
  p.log.step(pc.bold("Step 4 of 6: Access tokens"));

  p.log.info(
    `Almost there — now you'll create two access tokens in the browser, each\n` +
      `scoped as tightly as possible: a ${pc.green("GitHub fine-grained PAT")} (push to the\n` +
      `skills repo only) and a ${pc.cyan("Notion access token")} (read the Notion Skills DB only).`,
  );

  // --- 1. GitHub fine-grained PAT ---
  p.log.message(pc.bold("GitHub fine-grained PAT"));

  const patUrl = buildPatUrl(input.skillsRepo);
  p.log.info(
    `We'll open a token-creation page with everything pre-filled (name, owner,\n` +
      `${PAT_EXPIRES_IN_DAYS}-day expiration, Contents read/write). You only need to:\n` +
      `  1. Under ${pc.bold("Repository access")}, choose ${pc.bold("Only select repositories")} → pick ${pc.cyan(input.skillsRepo)}\n` +
      `  2. Click ${pc.bold("Generate token")} and copy it`,
  );
  p.log.warn(
    `If the token targets a ${pc.bold("GitHub organization")}, it may need admin approval\n` +
      `before it works. If push access is denied below, ask an org owner to approve it at:\n` +
      `  ${pc.bold("Organization Settings → Personal Access Tokens → Pending Requests")}\n` +
      `${pc.dim(`The token is scoped to only the ${input.skillsRepo} repo (Contents read/write) — that's all they're approving.`)}`,
  );

  const openPat = await p.confirm({
    message: "Open the GitHub token page in your browser?",
    initialValue: true,
  });
  if (p.isCancel(openPat)) return cancelled();
  if (openPat) {
    await openInBrowser(logger, "credentials", patUrl);
    p.log.message(pc.dim(`If the page didn't open: ${patUrl}`));
  } else {
    p.log.message(pc.dim(`Create it here when ready: ${patUrl}`));
  }

  let githubToken = "";
  for (;;) {
    const patInput = await p.password({
      message: "Paste the GitHub token:",
      validate: (v) =>
        !v || v.trim().length === 0 ? "Token cannot be empty" : undefined,
    });
    if (p.isCancel(patInput)) return cancelled();
    githubToken = String(patInput).trim();
    logger.registerSecret(githubToken);

    const validateSpinner = spinner();
    validateSpinner.start(`Checking push access to ${input.skillsRepo}...`);
    const validateResult = await loggedExec(
      logger,
      "credentials",
      "gh",
      ["api", `repos/${input.skillsRepo}`, "--jq", ".permissions.push"],
      { env: { GH_TOKEN: githubToken } },
    );
    const canPush =
      validateResult.code === 0 && validateResult.stdout.trim() === "true";
    logger.event("pat-validated", { canPush });

    if (canPush) {
      validateSpinner.stop("GitHub token verified — push access to the skills repo confirmed.");
      break;
    }

    validateSpinner.stop("Could not confirm push access with that token.");
    p.log.warn(
      `The token can't push to ${pc.cyan(input.skillsRepo)}. Usually this means the repo\n` +
        `wasn't selected under "Repository access", or the Contents permission isn't\n` +
        `Read and write.\n` +
        `If ${pc.cyan(input.skillsRepo)} is in an ${pc.bold("organization")}, the token may also be waiting on\n` +
        `admin approval — an org owner approves it at ${pc.bold("Organization Settings →")}\n` +
        `${pc.bold("Personal Access Tokens → Pending Requests")} (it's scoped to only that repo).`,
    );
    const retry = await p.select({
      message: "How do you want to proceed?",
      options: [
        { value: "again", label: "Paste a token again", hint: "fix the token settings first" },
        { value: "continue", label: "Continue anyway", hint: "the test sync will fail if it really can't push" },
      ],
    });
    if (p.isCancel(retry)) return cancelled();
    if (retry === "continue") break;
  }

  // --- 2. Notion access token ---
  p.log.message(pc.bold("Notion access token"));

  const integrationsUrl = myIntegrationsUrl(notionEnv);
  p.log.info(
    `Now create a Notion connection — we'll open the connections page:\n` +
      `  1. Click ${pc.bold("New connection")}\n` +
      `  2. In the modal: set the name (e.g. ${pc.bold('"Skills Sync"')}), pick ${pc.bold("Access token")} as the\n` +
      `     authentication method, choose your workspace, and create\n` +
      `  3. Copy the ${pc.bold("Access token")} once created`,
  );

  const openConnections = await p.confirm({
    message: "Open the Notion connections page in your browser?",
    initialValue: true,
  });
  if (p.isCancel(openConnections)) return cancelled();
  if (openConnections) {
    await openInBrowser(logger, "credentials", integrationsUrl);
    p.log.message(pc.dim(`If the page didn't open: ${integrationsUrl}`));
  } else {
    p.log.message(pc.dim(`Create it here when ready: ${integrationsUrl}`));
  }

  const notionInput = await p.password({
    message: "Paste the Notion access token:",
    validate: (v) => {
      if (!v || v.trim().length === 0) return "Token cannot be empty";
      const validPrefixes = ["ntn_", "secret_", "development_ntn_"];
      if (!validPrefixes.some((prefix) => v.trim().startsWith(prefix)))
        return "Token should start with ntn_, secret_, or development_ntn_";
      return undefined;
    },
  });
  if (p.isCancel(notionInput)) return cancelled();
  const notionToken = String(notionInput).trim();
  logger.registerSecret(notionToken);

  // The one step that had to wait for the DB to exist: connecting the
  // connection to it. There's no API for this — but we can verify it happened
  // by polling the DB with the new token instead of taking the user's word.
  p.log.info(
    `Last manual step — connect it to your Notion Skills DB\n` +
      `(we'll open it in the browser):\n` +
      `  1. Click ${pc.bold("···")} (top-right menu) → ${pc.bold("Connections")} → ${pc.bold("Add connection")}\n` +
      `  2. Select ${pc.bold('"Skills Sync"')}\n` +
      `${pc.dim("Without this, the access token can't see the database.")}`,
  );
  const openDb = await p.confirm({
    message: "Open the Notion Skills DB in your browser?",
    initialValue: true,
  });
  if (p.isCancel(openDb)) return cancelled();
  if (openDb) {
    await openInBrowser(logger, "credentials", input.databaseUrl);
    p.log.message(pc.dim(`If the page didn't open: ${input.databaseUrl}`));
  } else {
    p.log.message(pc.dim(`Add the connection here: ${input.databaseUrl}`));
  }

  const connected = await waitForConnection(logger, notionEnv, notionToken, input);
  if (connected === null) return cancelled();

  p.log.success("Access tokens ready.");
  return { notionToken, githubToken };
}

/**
 * Poll the Notion Skills DB with the integration token until the connection
 * shows up (or the user gives up). Returns false only if the user chose to
 * continue unconnected; null if they cancelled.
 */
async function waitForConnection(
  logger: WizardLogger,
  notionEnv: string,
  notionToken: string,
  input: CredentialsInput,
): Promise<boolean | null> {
  for (;;) {
    const pollSpinner = spinner();
    pollSpinner.start(
      `Waiting for the "Skills Sync" connection on "${input.dbName}"... (add it in Notion now)`,
    );

    // ~3 minutes per round: 60 polls, 3s apart.
    for (let attempt = 0; attempt < 60; attempt++) {
      const ok = await tokenCanReadDataSource(
        logger,
        "credentials",
        notionEnv,
        notionToken,
        input.dataSourceId,
      );
      if (ok) {
        pollSpinner.stop("Connection detected — the token can read the Notion Skills DB.");
        logger.event("notion-connection-detected", { attempts: attempt + 1 });
        return true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    pollSpinner.stop("Connection not detected yet.");

    const next = await p.select({
      message: "Still can't read the database with that token. What now?",
      options: [
        { value: "wait", label: "Keep waiting", hint: "finish adding the connection in Notion" },
        {
          value: "continue",
          label: "Continue anyway",
          hint: "the sync will fail until the connection is added",
        },
      ],
    });
    if (p.isCancel(next)) return null;
    if (next === "continue") {
      logger.event("notion-connection-skipped");
      p.log.warn(
        `Continuing without a verified connection. The test sync will fail unless\n` +
          `the connection is added to the database.`,
      );
      return false;
    }
  }
}

function cancelled(): null {
  p.cancel("Setup cancelled. Run this command again when you're ready.");
  return null;
}
