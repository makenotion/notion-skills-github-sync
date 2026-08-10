// Pull tool changes from `upstream` without destroying local work. Teams clone
// (not fork) this repo, push to their own `origin`, and keep the original as
// `upstream`, so updating is a plain guarded merge — config lives in `.env`
// now, which is gitignored and never part of a merge.
//
// `--ci` also pushes the merge back to `origin`, so the team's repo tracks
// upstream instead of re-merging into a throwaway runner checkout every hour.
//
// Accepted tradeoff: a bad upstream commit reaches every team on the next run.
// Pinning to tagged releases is the gate to add if that bites.

import { spawnSync } from "node:child_process";

/** Where `upstream` points when it has to be created (CI). */
export const DEFAULT_UPSTREAM_REPO = "makenotion/notion-skills-github-sync";
const UPSTREAM = "upstream";

export type UpdateStatus =
  | "up-to-date" // nothing new upstream
  | "merged" // fast-forwarded or merged cleanly
  | "conflict" // real conflicts; left for a human (or aborted in CI)
  | "no-upstream" // no upstream remote, and one couldn't be created
  | "fetch-failed"; // upstream unreachable (CI only; fatal interactively)

export interface UpdateResult {
  status: UpdateStatus;
  pushed: boolean;
  /** Files still conflicted, when status is "conflict". */
  conflicts: string[];
}

export interface UpdateOptions {
  /** Upstream branch to merge, and the branch to push back to. */
  branch?: string;
  /** Unattended: create `upstream` if missing, abort conflicts, push result. */
  ci?: boolean;
  /** `owner/name` on github.com, or any git URL/path. */
  upstreamRepo?: string;
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

/** `owner/name` means github.com; anything else is already a git URL or path. */
function upstreamUrl(repo: string): string {
  const looksLikeShorthand = /^[\w.-]+\/[\w.-]+$/.test(repo);
  return looksLikeShorthand ? `https://github.com/${repo}.git` : repo;
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

/** The branch to push back to: an explicit choice, the workflow's ref, or main. */
function pushBranch(opts: UpdateOptions): string {
  if (opts.branch) return opts.branch;
  const ref = process.env.GITHUB_REF_NAME?.trim();
  if (ref) return ref;
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  return current && current !== "HEAD" ? current : "main";
}

export function runUpdate(opts: UpdateOptions = {}): UpdateResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const branch = opts.branch ?? "main";

  if (git(["remote", "get-url", UPSTREAM]).code !== 0) {
    const repo = opts.upstreamRepo ?? process.env.UPSTREAM_REPO?.trim() ?? DEFAULT_UPSTREAM_REPO;
    if (!opts.ci) {
      throw new Error(
        `No '${UPSTREAM}' remote found — nothing to update from.\n` +
          `Point it at the tool repo you cloned, e.g.:\n` +
          `  git remote add ${UPSTREAM} https://github.com/${repo}.git`,
      );
    }
    // In CI the checkout only has `origin`, so the remote has to be created.
    const add = git(["remote", "add", UPSTREAM, upstreamUrl(repo)]);
    if (add.code !== 0) {
      log(`⚠ Could not add the '${UPSTREAM}' remote (${repo}); skipping auto-update.`);
      log(`  ${add.stderr.trim()}`);
      return { status: "no-upstream", pushed: false, conflicts: [] };
    }
    log(`Added '${UPSTREAM}' -> ${upstreamUrl(repo)}`);
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
    // Fatal interactively; in CI a transient failure must not stop the sync.
    if (!opts.ci) {
      throw new Error(`git fetch ${UPSTREAM} ${branch} failed:\n${fetched.stderr}`);
    }
    log(
      `⚠ Could not fetch ${UPSTREAM}/${branch}; skipping auto-update this run.\n` +
        `  ${fetched.stderr.trim()}`,
    );
    return { status: "fetch-failed", pushed: false, conflicts: [] };
  }

  const before = head();

  // CI has no git identity; supply one for this invocation only.
  const identity = opts.ci
    ? [
        "-c",
        `user.name=${process.env.GIT_AUTHOR_NAME?.trim() || "notion-skills-sync"}`,
        "-c",
        `user.email=${process.env.GIT_AUTHOR_EMAIL?.trim() || "notion-skills-sync@users.noreply.github.com"}`,
      ]
    : [];

  log(`Merging ${UPSTREAM}/${branch}…`);
  const merge = git([...identity, "merge", "--no-edit", `${UPSTREAM}/${branch}`]);

  if (merge.code !== 0) {
    const conflicts = conflicted();
    if (opts.ci) {
      // A half-merged checkout is worse than no update.
      git(["merge", "--abort"]);
      log(
        `⚠ Upstream merge conflicts — auto-update skipped this run. Resolve locally:\n` +
          conflicts.map((f) => `    - ${f}`).join("\n"),
      );
      return { status: "conflict", pushed: false, conflicts };
    }
    throw new Error(
      "Merged upstream, but these files have conflicts you'll need to resolve by hand:\n" +
        conflicts.map((f) => `  - ${f}`).join("\n") +
        "\n\nResolve them, then finish with:\n  git commit --no-edit\n" +
        "Or abandon the update and go back to how things were:\n  git merge --abort",
    );
  }

  if (head() === before) {
    log("✓ Already up to date with upstream.");
    return { status: "up-to-date", pushed: false, conflicts: [] };
  }
  log("✓ Merged upstream changes.");

  if (!opts.ci) {
    log(
      "\nYour settings live in .env and were untouched. Check .env.example for new\n" +
        "settings, then push the update:\n  git push origin HEAD",
    );
    return { status: "merged", pushed: false, conflicts: [] };
  }

  // --- Push the merge back so the team's repo tracks upstream ---
  const target = pushBranch(opts);
  const push = git(["push", "origin", `HEAD:${target}`]);
  if (push.code !== 0) {
    // Non-fatal: the sync still has the merged code in this checkout. The usual
    // cause is the pushing token being unable to touch .github/workflows —
    // GitHub requires the `workflows` permission for that, which the default
    // GITHUB_TOKEN does not have.
    log(
      `⚠ Merged upstream but could not push to origin/${target}; this run still uses the\n` +
        `  merged code, but the repo doesn't track it yet. If the update touched\n` +
        `  .github/workflows, the pushing token needs the 'workflows' permission.\n` +
        `  ${push.stderr.trim()}`,
    );
    return { status: "merged", pushed: false, conflicts: [] };
  }
  log(`✓ Pushed the update to origin/${target}.`);
  return { status: "merged", pushed: true, conflicts: [] };
}
