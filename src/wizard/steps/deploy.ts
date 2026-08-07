import * as p from "@clack/prompts";
import pc from "picocolors";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loggedExec } from "../exec.ts";
import { spinner } from "../spinner.ts";
import { abortWithHandoff } from "../handoff.ts";
import { CONFIG_ENV_VARS } from "../../config.ts";
import type { WizardLogger } from "../logger.ts";

export interface DeployResult {
  configPath: string;
}

interface DeployInput {
  skillsRepo: string; // the repo the sync pushes plugins to
  syncRepo: string; // the repo this sync code lives in — where the Action runs
  syncRepoDefaultBranch: string;
  dataSourceId: string;
  databaseId: string;
  notionToken: string;
  githubToken: string;
  notionEnv: string;
}

/**
 * Phase 5: the unattended deploy tail. Everything here was approved at the
 * plan summary, so there are no prompts — just spinners. Real failures abort
 * with a handoff; nothing falls through to the happy-path wrapup.
 */
export async function stepDeploy(
  logger: WizardLogger,
  input: DeployInput,
): Promise<DeployResult> {
  p.log.step(pc.bold("Step 5 of 6: Deploy and verify"));

  // Defensively register tokens as secrets so nothing here leaks to the log.
  logger.registerSecret(input.notionToken);
  logger.registerSecret(input.githubToken);
  logger.event("deploy-input", {
    skillsRepo: input.skillsRepo,
    syncRepo: input.syncRepo,
    syncRepoDefaultBranch: input.syncRepoDefaultBranch,
    dataSourceId: input.dataSourceId,
    databaseId: input.databaseId,
    notionEnv: input.notionEnv,
    hasNotionToken: Boolean(input.notionToken),
    hasGithubToken: Boolean(input.githubToken),
  });

  p.log.info(
    `Time to deploy and verify everything — no more questions from here; sit back\n` +
      `and watch.`,
  );

  // --- 1. Write config.json (local only) ---
  // This is for the local test sync below. config.json is gitignored and is
  // NEVER committed — otherwise every user who clones the sync repo would
  // inherit our data-source ids and repo. The deployed workflow gets its
  // config from repo variables instead (set in step 3b).
  const configSpinner = spinner();
  configSpinner.start("Writing config.json (local, gitignored)...");

  const config = {
    notionEnv: input.notionEnv,
    skillsDataSourceId: input.dataSourceId,
    skillsDatabaseId: input.databaseId,
    githubRepo: input.skillsRepo,
    githubBranch: "main",
    pluginsDir: "plugins",
    authorName: "notion-skills-sync",
    authorEmail: "notion-skills-sync@users.noreply.github.com",
  };

  const configPath = join(process.cwd(), "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  configSpinner.stop("config.json written (local, gitignored).");

  logger.log({
    timestamp: new Date().toISOString(),
    step: "deploy",
    command: `write ${configPath}`,
    exitCode: 0,
    stdout: JSON.stringify(config),
    duration_ms: 0,
  });

  // --- 2. Push the sync script repo ---
  // GitHub only registers workflows (for both the schedule and manual
  // dispatch) from the repo's *configured* default branch — push there
  // explicitly. Pushing a differently-named branch to a fresh repo races the
  // default-branch switch and leaves the workflow unregistered.
  //
  // We push HEAD as-is (config.json is gitignored, so it isn't included).
  const branch = input.syncRepoDefaultBranch;
  const pushSpinner = spinner();
  pushSpinner.start(
    `Pushing the sync script repo to ${pc.cyan(`${input.syncRepo}:${branch}`)}...`,
  );

  const pushResult = await loggedExec(logger, "deploy", "git", [
    "push", "-u", "origin", `HEAD:${branch}`,
  ]);
  logger.event("push-result", { code: pushResult.code, branch });
  if (pushResult.code !== 0) {
    pushSpinner.stop("Push failed.");
    abortWithHandoff(logger, {
      step: "push sync script repo",
      what:
        `Could not push to ${input.syncRepo} (branch ${branch}). ` +
        `If the remote branch has diverged, the local branch may need a merge/rebase first.`,
      detail: pushResult.stderr,
    });
  }
  pushSpinner.stop(
    `Pushed to ${pc.cyan(`${input.syncRepo}:${branch}`)} — the workflow is now on GitHub.`,
  );

  // --- 3. Set the secrets on the SYNC SCRIPT repo ---
  // The workflow runs there, so that's where it reads its secrets from — NOT
  // the skills repo.
  const secretSpinner = spinner();
  secretSpinner.start(`Setting the two secrets on ${pc.cyan(input.syncRepo)}...`);

  // Pipe values via env so tokens never appear in argv or the log.
  const notionSecretResult = await loggedExec(
    logger,
    "deploy",
    "bash",
    ["-c", `printf '%s' "$SECRET_VALUE" | gh secret set NOTION_API_TOKEN --repo "${input.syncRepo}"`],
    { env: { SECRET_VALUE: input.notionToken } },
  );
  const ghSecretResult = await loggedExec(
    logger,
    "deploy",
    "bash",
    ["-c", `printf '%s' "$SECRET_VALUE" | gh secret set GH_PUSH_TOKEN --repo "${input.syncRepo}"`],
    { env: { SECRET_VALUE: input.githubToken } },
  );
  logger.event("secrets-set-result", {
    notionSecretCode: notionSecretResult.code,
    ghSecretCode: ghSecretResult.code,
  });

  if (notionSecretResult.code !== 0 || ghSecretResult.code !== 0) {
    secretSpinner.stop("Setting secrets failed.");
    const failed =
      notionSecretResult.code !== 0 ? notionSecretResult : ghSecretResult;
    abortWithHandoff(logger, {
      step: "set repository secrets",
      what: `Could not set the workflow secrets on ${input.syncRepo} via \`gh secret set\`.`,
      detail: failed.stderr || "Permission denied or network error.",
    });
  }
  secretSpinner.stop(
    `Secrets stored (encrypted) on ${pc.cyan(input.syncRepo)}: NOTION_API_TOKEN, GH_PUSH_TOKEN.`,
  );

  // --- 3b. Set the non-secret config as repo VARIABLES ---
  // These replace the committed config.json for the deployed workflow: the
  // sync.yml maps `vars.*` onto the CONFIG_ENV_VARS the CLI reads. They're not
  // secret (data-source ids, repo name, etc.), so they go in argv, not stdin.
  const varSpinner = spinner();
  varSpinner.start(`Setting config variables on ${pc.cyan(input.syncRepo)}...`);

  const variables: Array<[name: string, value: string]> = [
    [CONFIG_ENV_VARS.notionEnv, config.notionEnv],
    [CONFIG_ENV_VARS.skillsDataSourceId, config.skillsDataSourceId],
    [CONFIG_ENV_VARS.skillsDatabaseId, config.skillsDatabaseId],
    [CONFIG_ENV_VARS.githubRepo, config.githubRepo],
    [CONFIG_ENV_VARS.githubBranch, config.githubBranch],
    [CONFIG_ENV_VARS.pluginsDir, config.pluginsDir],
    [CONFIG_ENV_VARS.authorName, config.authorName],
    [CONFIG_ENV_VARS.authorEmail, config.authorEmail],
  ];

  const failedVars: string[] = [];
  for (const [name, value] of variables) {
    if (!value) continue;
    const res = await loggedExec(logger, "deploy", "gh", [
      "variable", "set", name,
      "--repo", input.syncRepo,
      "--body", value,
    ]);
    if (res.code !== 0) failedVars.push(name);
  }
  logger.event("variables-set-result", {
    total: variables.length,
    failed: failedVars,
  });

  if (failedVars.length) {
    varSpinner.stop("Setting config variables failed.");
    abortWithHandoff(logger, {
      step: "set repository variables",
      what:
        `Could not set config variable(s) on ${input.syncRepo} via \`gh variable set\`: ` +
        `${failedVars.join(", ")}.`,
      detail:
        "The token used by `gh` needs variables:write (actions) on the repo. " +
        "The workflow reads these via `vars.*` — without them the sync has no config.",
    });
  }
  varSpinner.stop(
    `Config stored on ${pc.cyan(input.syncRepo)} as ${variables.length} repo variable(s).`,
  );

  // --- 4. Local test sync — with the SAME credentials the workflow will use ---
  const syncEnv = {
    GITHUB_TOKEN: input.githubToken,
    NOTION_API_TOKEN: input.notionToken,
  };

  const dryRunSpinner = spinner();
  dryRunSpinner.start("Running dry-run sync...");
  const dryRunResult = await loggedExec(
    logger,
    "deploy",
    "bun",
    ["run", "src/cli.ts", "sync", "--dry-run"],
    { env: syncEnv },
  );
  if (dryRunResult.code !== 0) {
    dryRunSpinner.stop("Dry-run failed.");
    abortWithHandoff(logger, {
      step: "local test sync (dry-run)",
      what: "The dry-run sync exited non-zero — reading from Notion or planning the commit failed.",
      detail: dryRunResult.stderr || dryRunResult.stdout,
    });
  }
  dryRunSpinner.stop("Dry-run succeeded.");
  p.log.info(pc.dim(dryRunResult.stdout.split("\n").slice(-5).join("\n")));

  const syncSpinner = spinner();
  syncSpinner.start("Running actual sync...");
  const syncResult = await loggedExec(
    logger,
    "deploy",
    "bun",
    ["run", "src/cli.ts", "sync"],
    { env: syncEnv },
  );
  if (syncResult.code !== 0) {
    syncSpinner.stop("Sync failed.");
    abortWithHandoff(logger, {
      step: "local test sync",
      what: `The sync to ${input.skillsRepo} exited non-zero.`,
      detail: syncResult.stderr || syncResult.stdout,
    });
  }
  syncSpinner.stop("Sync completed successfully!");
  p.log.success(pc.dim(syncResult.stdout.split("\n").slice(-3).join("\n")));

  const idempotencySpinner = spinner();
  idempotencySpinner.start("Verifying idempotency (re-running sync)...");
  const idemResult = await loggedExec(
    logger,
    "deploy",
    "bun",
    ["run", "src/cli.ts", "sync"],
    { env: syncEnv },
  );
  if (
    idemResult.stdout.includes("Up to date") ||
    idemResult.stdout.includes("no commit needed")
  ) {
    idempotencySpinner.stop("Idempotency check passed — no unnecessary commits.");
  } else {
    idempotencySpinner.stop(
      "Note: re-run produced changes (may be expected on first setup).",
    );
  }

  // --- 5. E2E: trigger a GitHub Actions run and watch it ---
  await verifyActionsRun(logger, {
    syncRepo: input.syncRepo,
    defaultBranch: branch,
  });

  return { configPath };
}

// Trigger the sync.yml workflow on the sync script repo and watch it to
// completion — this proves the production path (Actions runner + secrets +
// push) works, not just a sync from this machine.
async function verifyActionsRun(
  logger: WizardLogger,
  opts: { syncRepo: string; defaultBranch: string },
): Promise<void> {
  // GitHub registers workflows asynchronously after the push to the default
  // branch is processed — poll until sync.yml shows up as active.
  const regSpinner = spinner();
  regSpinner.start("Waiting for GitHub to register the workflow...");
  let registered = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const wf = await loggedExec(logger, "actions-test", "gh", [
      "api",
      `repos/${opts.syncRepo}/actions/workflows/sync.yml`,
      "--jq",
      ".state",
    ]);
    if (wf.code === 0 && wf.stdout.trim() === "active") {
      registered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!registered) {
    regSpinner.stop("Workflow never registered.");
    abortWithHandoff(logger, {
      step: "verify GitHub Actions",
      what:
        `GitHub did not register .github/workflows/sync.yml on ${opts.syncRepo} after the push. ` +
        `It must exist on the default branch (${opts.defaultBranch}) and Actions must be enabled on the repo.`,
    });
  }
  regSpinner.stop("Workflow registered with GitHub.");

  // Remember the newest existing run so we can spot the one we're about to start.
  const listArgs = [
    "run", "list",
    "--workflow", "sync.yml",
    "--repo", opts.syncRepo,
    "--limit", "1",
    "--json", "databaseId",
    "--jq", ".[0].databaseId",
  ];
  const before = await loggedExec(logger, "actions-test", "gh", listArgs);
  const previousRunId = before.code === 0 ? before.stdout.trim() : "";

  const dispatchSpinner = spinner();
  dispatchSpinner.start("Dispatching the sync workflow...");
  const dispatch = await loggedExec(logger, "actions-test", "gh", [
    "workflow", "run", "sync.yml",
    "--repo", opts.syncRepo,
    "--ref", opts.defaultBranch,
  ]);
  if (dispatch.code !== 0) {
    dispatchSpinner.stop("Could not dispatch the workflow.");
    abortWithHandoff(logger, {
      step: "verify GitHub Actions",
      what: `Dispatching sync.yml on ${opts.syncRepo} (ref ${opts.defaultBranch}) failed.`,
      detail: dispatch.stderr,
    });
  }
  dispatchSpinner.stop("Workflow dispatched.");

  // The run takes a few seconds to appear in the API — poll for a new run id.
  const findSpinner = spinner();
  findSpinner.start("Waiting for the run to start...");
  let runId = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const listing = await loggedExec(logger, "actions-test", "gh", listArgs);
    const latest = listing.code === 0 ? listing.stdout.trim() : "";
    if (latest && latest !== previousRunId) {
      runId = latest;
      break;
    }
  }
  if (!runId) {
    findSpinner.stop("Run did not appear in time.");
    abortWithHandoff(logger, {
      step: "verify GitHub Actions",
      what:
        `The dispatched run never appeared in ${opts.syncRepo}'s run list. ` +
        `Check https://github.com/${opts.syncRepo}/actions for stuck or missing runs.`,
    });
  }
  findSpinner.stop(`Run started (id ${runId}).`);

  const watchSpinner = spinner();
  watchSpinner.start("Watching the run (usually 1–2 minutes)...");
  const watch = await loggedExec(logger, "actions-test", "gh", [
    "run", "watch", runId,
    "--repo", opts.syncRepo,
    "--exit-status",
    "--interval", "5",
  ]);
  if (watch.code !== 0) {
    watchSpinner.stop("GitHub Actions run failed.");
    abortWithHandoff(logger, {
      step: "verify GitHub Actions",
      what:
        `The workflow run on ${opts.syncRepo} did not succeed. ` +
        `Inspect it with \`gh run view ${runId} --repo ${opts.syncRepo} --log\`. ` +
        `Common causes: missing/expired secrets, or GH_PUSH_TOKEN lacking push access to the skills repo.`,
      detail: watch.stderr,
    });
  }
  watchSpinner.stop("GitHub Actions run passed!");
  p.log.success(
    `The production path works end to end: the workflow read Notion, and pushed (or\n` +
      `confirmed "Up to date") on the skills repo. It will now run hourly on its own.`,
  );
}
