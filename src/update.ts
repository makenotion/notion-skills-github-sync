// Pull tool changes from `upstream` without destroying local work. Teams clone
// (not fork) this repo, push to their own `origin`, and keep the original as
// `upstream`, so updating is a plain guarded merge — config lives in `.env`,
// which is gitignored and never part of a merge.

import { spawnSync } from "node:child_process";

/** Where to point `upstream` when it's missing (shown in the error). */
export const DEFAULT_UPSTREAM_REPO = "makenotion/notion-skills-github-sync";
const UPSTREAM = "upstream";

export type UpdateStatus =
  | "up-to-date" // nothing new upstream
  | "merged"; // fast-forwarded or merged cleanly

export interface UpdateResult {
  status: UpdateStatus;
}

export interface UpdateOptions {
  /** Upstream branch to merge. */
  branch?: string;
  log?: (message: string) => void;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[]): GitResult {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function conflicted(): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"])
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function head(): string {
  return git(["rev-parse", "HEAD"]).stdout.trim();
}

export function runUpdate(opts: UpdateOptions = {}): UpdateResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const branch = opts.branch ?? "main";

  if (git(["remote", "get-url", UPSTREAM]).code !== 0) {
    throw new Error(
      `No '${UPSTREAM}' remote found — nothing to update from.\n` +
        `Point it at the tool repo you cloned, e.g.:\n` +
        `  git remote add ${UPSTREAM} https://github.com/${DEFAULT_UPSTREAM_REPO}.git`,
    );
  }

  // Merging over uncommitted work is how an update loses someone's edits.
  if (git(["status", "--porcelain"]).stdout.trim() !== "") {
    throw new Error(
      "You have uncommitted changes. Commit or stash them first, then re-run `bun run update`.",
    );
  }

  log(`Fetching ${UPSTREAM}…`);
  const fetched = git(["fetch", UPSTREAM, branch]);
  if (fetched.code !== 0) {
    throw new Error(`git fetch ${UPSTREAM} ${branch} failed:\n${fetched.stderr}`);
  }

  const before = head();

  log(`Merging ${UPSTREAM}/${branch}…`);
  const merge = git(["merge", "--no-edit", `${UPSTREAM}/${branch}`]);

  if (merge.code !== 0) {
    throw new Error(
      "Merged upstream, but these files have conflicts you'll need to resolve by hand:\n" +
        conflicted()
          .map((f) => `  - ${f}`)
          .join("\n") +
        "\n\nResolve them, then finish with:\n  git commit --no-edit\n" +
        "Or abandon the update and go back to how things were:\n  git merge --abort",
    );
  }

  if (head() === before) {
    log("✓ Already up to date with upstream.");
    return { status: "up-to-date" };
  }

  log(
    "✓ Merged upstream changes.\n\n" +
      "Your settings live in .env and were untouched. Check .env.example for new\n" +
      "settings, then push the update:\n  git push origin HEAD",
  );
  return { status: "merged" };
}
