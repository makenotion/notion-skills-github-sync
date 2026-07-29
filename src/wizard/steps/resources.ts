import pc from "picocolors";
import { loggedExec } from "../exec.ts";
import { abortWithHandoff } from "../handoff.ts";
import { createSkillsDb, populateSampleSkills } from "../skills-db.ts";
import type { WizardIO } from "../io.ts";
import type { WizardLogger } from "../logger.ts";
import type { Decisions } from "./decisions.ts";

export interface Resources {
  dataSourceId: string;
  databaseId: string;
  databaseUrl: string;
  skillsRepoUrl: string;
  /** Configured default branch of the sync script repo — where the workflow must live. */
  syncRepoDefaultBranch: string;
}

/**
 * Phase 3: create everything the decisions described. No prompts — real
 * failures abort with a handoff. Runs in seconds.
 */
export async function stepCreateResources(
  io: WizardIO,
  logger: WizardLogger,
  notionEnv: string,
  decisions: Decisions,
): Promise<Resources> {
  io.step(pc.bold("Step 3 of 6: Creating your resources"));

  io.info(
    `Now we'll create your database and repos — this only takes a few seconds.`,
  );

  // --- Notion Skills DB ---
  const dbSpinner = io.spinner();
  dbSpinner.start(`Creating the Notion Skills DB ("${decisions.dbName}")...`);
  const dbResult = await createSkillsDb(logger, "resources", notionEnv, {
    dbName: decisions.dbName,
  });
  if (!dbResult.ok) {
    dbSpinner.stop("Failed to create the Notion Skills DB.");
    abortWithHandoff(io, logger, {
      step: "create Notion Skills DB",
      what: "Creating the skills database in Notion failed.",
      detail: dbResult.error,
    });
  }
  dbSpinner.stop(`Notion Skills DB created: ${pc.cyan(dbResult.db.databaseUrl)}`);

  const populateSpinner = io.spinner();
  populateSpinner.start("Adding sample skills...");
  const { created, total, zipsAttached, zipsTotal } = await populateSampleSkills(
    logger,
    "resources",
    notionEnv,
    dbResult.db.dataSourceId,
  );
  populateSpinner.stop(`Added ${created}/${total} sample skills.`);
  if (created < total) {
    io.warn("Some sample skills failed to create. You can add skills manually later.");
  }
  if (zipsAttached < zipsTotal) {
    io.warn(
      "A sample skill's bundled files (zip attachment) could not be uploaded — the skill was created without them.",
    );
  }

  // --- Skills repo ---
  const { repo: skillsRepo } = decisions.skillsRepo;
  const skillsRepoUrl = `https://github.com/${skillsRepo}`;

  if (decisions.skillsRepo.isNew) {
    const repoSpinner = io.spinner();
    repoSpinner.start(`Creating the skills repo ${pc.cyan(skillsRepo)}...`);
    const createResult = await loggedExec(logger, "resources", "gh", [
      "repo", "create", skillsRepo,
      "--private",
      "--description", "Skills marketplace synced from Notion",
    ]);
    if (createResult.code !== 0) {
      if (createResult.stderr.includes("already exists")) {
        repoSpinner.stop(`Skills repo ${pc.cyan(skillsRepo)} already exists — using it.`);
      } else {
        repoSpinner.stop("Failed to create the skills repo.");
        abortWithHandoff(io, logger, {
          step: "create skills repo",
          what: `Could not create ${skillsRepo} via \`gh repo create\`.`,
          detail: createResult.stderr,
        });
      }
    } else {
      repoSpinner.stop(`Skills repo created: ${pc.cyan(skillsRepoUrl)}`);
    }

    // Initialize with a README so the repo has a base commit for the sync.
    const name = skillsRepo.split("/")[1] ?? skillsRepo;
    const initResult = await loggedExec(logger, "resources", "gh", [
      "api", `repos/${skillsRepo}/contents/README.md`,
      "-X", "PUT",
      "-f", "message=Initial commit",
      "-f", `content=${Buffer.from(`# ${name}\n\nSkills marketplace synced from Notion.\n`).toString("base64")}`,
    ]);
    if (
      initResult.code !== 0 &&
      !initResult.stderr.includes("already exists") &&
      !initResult.stderr.includes("Invalid request")
    ) {
      io.warn(
        "Could not create the skills repo's initial commit. The sync will handle this, " +
          "but the first run may need the repo to have at least one commit.",
      );
    }
  } else {
    // Existing repo: verify it's actually reachable before building on it.
    const checkResult = await loggedExec(logger, "resources", "gh", [
      "api", `repos/${skillsRepo}`, "--jq", ".full_name",
    ]);
    if (checkResult.code !== 0) {
      abortWithHandoff(io, logger, {
        step: "verify skills repo",
        what: `The skills repo ${skillsRepo} doesn't exist or isn't accessible with your gh login.`,
        detail: checkResult.stderr,
      });
    }
    io.success(`Using existing skills repo: ${pc.cyan(skillsRepoUrl)}`);
  }

  // --- Sync script repo ---
  const { repo: syncRepo } = decisions.syncScriptRepo;
  if (decisions.syncScriptRepo.isNew) {
    const syncSpinner = io.spinner();
    syncSpinner.start(`Creating the sync script repo ${pc.cyan(syncRepo)} (private)...`);
    const createResult = await loggedExec(logger, "resources", "gh", [
      "repo", "create", syncRepo,
      "--private",
      "--description", "Syncs skills from Notion into a Claude plugin marketplace",
    ]);
    if (createResult.code !== 0 && !createResult.stderr.includes("already exists")) {
      syncSpinner.stop("Failed to create the sync script repo.");
      abortWithHandoff(io, logger, {
        step: "create sync script repo",
        what: `Could not create ${syncRepo} via \`gh repo create\`.`,
        detail: createResult.stderr,
      });
    }

    // Point origin at the new repo; keep any previous origin (the upstream
    // tool repo) as `upstream` so the user can still pull updates.
    const hadOrigin = (await loggedExec(logger, "resources", "git", [
      "remote", "get-url", "origin",
    ])).code === 0;
    if (hadOrigin) {
      const rename = await loggedExec(logger, "resources", "git", [
        "remote", "rename", "origin", "upstream",
      ]);
      if (rename.code !== 0) {
        // `upstream` may already exist — just drop origin so we can re-add it.
        await loggedExec(logger, "resources", "git", ["remote", "remove", "origin"]);
      }
    }
    const addRemote = await loggedExec(logger, "resources", "git", [
      "remote", "add", "origin", `https://github.com/${syncRepo}.git`,
    ]);
    if (addRemote.code !== 0) {
      syncSpinner.stop("Repo created, but could not set the origin remote.");
      abortWithHandoff(io, logger, {
        step: "create sync script repo",
        what: `Created ${syncRepo}, but could not point the origin remote at it.`,
        detail: addRemote.stderr,
      });
    }
    syncSpinner.stop(
      `Sync script repo ready: ${pc.cyan(syncRepo)}` +
        (hadOrigin ? pc.dim(" (previous origin kept as `upstream`)") : ""),
    );
  } else {
    io.success(`Sync script repo: ${pc.cyan(syncRepo)} (current origin)`);
  }

  // GitHub only registers workflows from the repo's *configured* default
  // branch — deploy pushes there explicitly, so resolve it now.
  const defaultBranchResult = await loggedExec(logger, "resources", "gh", [
    "api", `repos/${syncRepo}`, "--jq", ".default_branch",
  ]);
  const syncRepoDefaultBranch =
    defaultBranchResult.code === 0 && defaultBranchResult.stdout.trim()
      ? defaultBranchResult.stdout.trim()
      : "main";

  logger.event("resources-created", {
    databaseId: dbResult.db.databaseId,
    dataSourceId: dbResult.db.dataSourceId,
    skillsRepo,
    syncRepo,
    syncRepoDefaultBranch,
  });

  return {
    dataSourceId: dbResult.db.dataSourceId,
    databaseId: dbResult.db.databaseId,
    databaseUrl: dbResult.db.databaseUrl,
    skillsRepoUrl,
    syncRepoDefaultBranch,
  };
}
