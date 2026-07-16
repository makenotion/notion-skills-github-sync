import { spawnSync } from "node:child_process";

// The remote that points at the original tool repo. The guided setup renames the
// cloned `origin` to `upstream` (src/wizard/steps/resources.ts) so users can pull
// tool updates without touching their own `origin`.
const UPSTREAM = "upstream";

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function conflicted(): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"]).stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pull the latest tool changes from `upstream` while keeping the user's own
 * `config.json`. `config.json` is the only per-user file in the repo, so a plain
 * `git merge upstream/main` collides on it every time; this command merges and
 * auto-resolves that one file in favor of the local copy.
 */
export function runUpdate(opts: { branch?: string } = {}): void {
  if (git(["remote", "get-url", UPSTREAM]).code !== 0) {
    throw new Error(
      `No '${UPSTREAM}' remote found — nothing to update from.\n` +
        `Point it at the original tool repo, e.g.:\n` +
        `  git remote add ${UPSTREAM} https://github.com/makenotion/notion-skills-github-sync.git`,
    );
  }

  if (git(["status", "--porcelain"]).stdout.trim() !== "") {
    throw new Error(
      "You have uncommitted changes. Commit or stash them first, then re-run `bun run update`.",
    );
  }

  // Makes `config.json merge=ours` (see .gitattributes) actually take effect.
  // The driver lives in local git config (not committed), so set it each run;
  // it's idempotent. Belt-and-suspenders: the fallback below also protects
  // config.json for clones made before .gitattributes existed.
  git(["config", "merge.ours.driver", "true"]);

  const branch = opts.branch ?? "main";

  console.log(`Fetching latest from ${UPSTREAM}…`);
  const fetch = git(["fetch", UPSTREAM]);
  if (fetch.code !== 0) throw new Error(`git fetch ${UPSTREAM} failed:\n${fetch.stderr}`);

  console.log(`Merging ${UPSTREAM}/${branch} into ${branch}…`);
  const merge = git(["merge", "--no-edit", `${UPSTREAM}/${branch}`]);
  if (merge.code === 0) {
    console.log(merge.stdout.trim() || "✓ Already up to date.");
    finish();
    return;
  }

  // Merge stopped on conflicts. Keep our config.json and see what's left.
  if (conflicted().includes("config.json")) {
    git(["checkout", "--ours", "--", "config.json"]);
    git(["add", "config.json"]);
  }

  const remaining = conflicted();
  if (remaining.length === 0) {
    const commit = git(["commit", "--no-edit"]);
    if (commit.code !== 0) throw new Error(`Could not finish the merge:\n${commit.stderr}`);
    console.log("✓ Merged upstream updates — your config.json was kept as-is.");
    finish();
    return;
  }

  // Conflicts outside config.json mean the user edited tool code. Leave the
  // half-done merge in place so they can resolve it deliberately.
  throw new Error(
    "Merged upstream, but these files have conflicts you'll need to resolve by hand:\n" +
      remaining.map((f) => `  - ${f}`).join("\n") +
      "\n\nResolve them, then finish with:\n  git commit --no-edit\n" +
      "Or abandon the update and go back to how things were:\n  git merge --abort",
  );
}

function finish(): void {
  console.log(
    "\nReview new settings in config.json.example (your config.json is untouched),\n" +
      "then push the update to your repo:\n  git push origin HEAD",
  );
}
