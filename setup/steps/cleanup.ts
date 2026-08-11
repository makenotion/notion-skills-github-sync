import * as p from "@clack/prompts";
import pc from "picocolors";
import { loggedExec } from "../exec.ts";
import { spinner } from "../spinner.ts";
import type { SetupLogger } from "../logger.ts";
import type { Decisions } from "./decisions.ts";

interface CleanupInput {
  skillsRepo: Decisions["skillsRepo"];
  syncScriptRepo: Decisions["syncScriptRepo"];
  dbName: string;
  databaseUrl: string;
}

/**
 * Test-run tail (`setup --test-run`): the whole setup ran for real, so now
 * help tear down the GitHub repos it created. Only repos created BY this run
 * (isNew) are candidates — a pre-existing repo the user chose to reuse is
 * never deleted. The Notion Skills DB is deliberately left alone; we point at
 * it so the user can trash it in Notion.
 */
export async function stepCleanup(
  logger: SetupLogger,
  input: CleanupInput,
): Promise<void> {
  p.log.step(pc.bold("Test run: clean up"));

  p.log.info(
    `This was a test run — let's delete the GitHub repos the setup created.\n` +
      `Everything above ran for real, so until they're deleted the hourly sync\n` +
      `workflow stays live.`,
  );

  const candidates: Array<{
    repo: string;
    label: string;
    restoreRemotes: boolean;
  }> = [];
  if (input.skillsRepo.isNew) {
    candidates.push({
      repo: input.skillsRepo.repo,
      label: "skills repo",
      restoreRemotes: false,
    });
  } else {
    p.log.info(
      `Skills repo ${pc.cyan(input.skillsRepo.repo)} existed before this run — leaving it alone.`,
    );
  }
  if (input.syncScriptRepo.isNew) {
    candidates.push({
      repo: input.syncScriptRepo.repo,
      label: "sync script repo",
      restoreRemotes: true,
    });
  } else {
    p.log.info(
      `Sync script repo ${pc.cyan(input.syncScriptRepo.repo)} existed before this run — leaving it alone.`,
    );
  }

  if (candidates.length === 0) {
    p.log.info("No repos were created by this run, so there's nothing to delete.");
  }
  for (const candidate of candidates) {
    await deleteRepo(logger, candidate);
  }

  p.log.message(
    pc.bold("Not cleaned up automatically:") +
      `\n  • The Notion Skills DB ${pc.cyan(`"${input.dbName}"`)} — trash it in Notion if you're done:\n` +
      `    ${pc.cyan(input.databaseUrl)}` +
      `\n  • Your local ${pc.cyan(".env")} still holds this run's settings and tokens.`,
  );

  p.outro(pc.bold("Test run cleanup finished."));
}

async function deleteRepo(
  logger: SetupLogger,
  candidate: { repo: string; label: string; restoreRemotes: boolean },
): Promise<void> {
  const confirmDelete = await p.confirm({
    message: `Delete the ${candidate.label} ${candidate.repo}?`,
    initialValue: true,
  });
  logger.event("cleanup-delete-confirm", {
    repo: candidate.repo,
    cancelled: p.isCancel(confirmDelete),
    value: p.isCancel(confirmDelete) ? null : confirmDelete,
  });
  if (p.isCancel(confirmDelete) || !confirmDelete) {
    p.log.info(`Keeping ${pc.cyan(candidate.repo)}.`);
    return;
  }

  for (;;) {
    const deleteSpinner = spinner();
    deleteSpinner.start(`Deleting ${candidate.repo}...`);
    const result = await loggedExec(logger, "cleanup", "gh", [
      "repo", "delete", candidate.repo, "--yes",
    ]);
    logger.event("cleanup-delete-result", {
      repo: candidate.repo,
      code: result.code,
    });
    if (result.code === 0) {
      deleteSpinner.stop(`Deleted ${pc.cyan(candidate.repo)}.`);
      if (candidate.restoreRemotes) await restoreRemotes(logger);
      return;
    }
    deleteSpinner.stop(`Could not delete ${candidate.repo}.`);

    // gh's cached OAuth token doesn't carry delete_repo by default — the
    // most common failure here, and it's fixable without leaving setup.
    if (result.stderr.includes("delete_repo")) {
      p.log.warn(
        `Your gh login is missing the ${pc.bold("delete_repo")} scope. In another terminal, run:\n` +
          `  ${pc.cyan("gh auth refresh -h github.com -s delete_repo")}\n` +
          `then pick "Try again" here.`,
      );
    } else {
      p.log.warn(result.stderr.trim() || "Unknown error from `gh repo delete`.");
    }

    const next = await p.select({
      message: `What now for ${candidate.repo}?`,
      options: [
        { value: "again", label: "Try again" },
        {
          value: "skip",
          label: "Skip — I'll delete it manually",
          hint: `https://github.com/${candidate.repo}/settings`,
        },
      ],
    });
    if (p.isCancel(next) || next === "skip") {
      p.log.info(
        `Skipped — delete it at ${pc.cyan(`https://github.com/${candidate.repo}/settings`)} when ready.`,
      );
      return;
    }
  }
}

/**
 * The resources step pointed `origin` at the new sync script repo, keeping any
 * previous origin as `upstream`. That repo is gone now, so undo the rewiring:
 * drop `origin` and rename `upstream` back — leaving the checkout as the test
 * run found it, ready for another run.
 */
async function restoreRemotes(logger: SetupLogger): Promise<void> {
  await loggedExec(logger, "cleanup", "git", ["remote", "remove", "origin"]);
  const rename = await loggedExec(logger, "cleanup", "git", [
    "remote", "rename", "upstream", "origin",
  ]);
  p.log.info(
    rename.code === 0
      ? "Local git remotes restored: the previous origin (kept as `upstream`) is `origin` again."
      : "Removed the `origin` remote (it pointed at the deleted repo).",
  );
}
