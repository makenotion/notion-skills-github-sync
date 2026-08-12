// `update` is tested against real git repositories in a temp dir, because every
// interesting case is a git behaviour: refusing a dirty tree, a clean
// fast-forward, and a conflict. Faking git here would only test our idea of git.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdate } from "../src/update.ts";

const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((r.status ?? 1) !== 0 && !args.includes("--porcelain")) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr}`);
  }
  return (r.stdout ?? "").trim();
};

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
const commit = (cwd: string, message: string) => {
  git(cwd, ["add", "-A"]);
  git(cwd, [...IDENTITY, "commit", "-m", message]);
};

interface Fixture {
  /** The tool repo everyone updates from. */
  upstream: string;
  /** The team's own copy: `origin` is theirs, `upstream` is the tool repo. */
  clone: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "skills-update-"));

  const upstream = join(root, "upstream");
  git(root, ["init", "-q", "-b", "main", "upstream"]);
  writeFileSync(join(upstream, "tool.ts"), "v1\n");
  commit(upstream, "tool v1");

  const originBare = join(root, "origin.git");
  git(root, ["init", "-q", "--bare", "-b", "main", "origin.git"]);

  const clone = join(root, "clone");
  git(root, ["clone", "-q", upstream, "clone"]);
  git(clone, ["remote", "rename", "origin", "upstream"]);
  git(clone, ["remote", "add", "origin", originBare]);
  git(clone, ["push", "-q", "origin", "main"]);
  git(clone, [...IDENTITY, "config", "user.name", "Test"]);
  git(clone, ["config", "user.email", "test@example.com"]);

  return { upstream, clone };
}

let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(cwd);
});

const update = (dir: string, opts: Parameters<typeof runUpdate>[0] = {}) => {
  process.chdir(dir);
  return runUpdate({ log: () => {}, ...opts });
};

describe("runUpdate", () => {
  test("reports up-to-date without touching anything", () => {
    const { clone } = makeFixture();
    const before = git(clone, ["rev-parse", "HEAD"]);

    const result = update(clone);

    expect(result.status).toBe("up-to-date");
    expect(git(clone, ["rev-parse", "HEAD"])).toBe(before);
  });

  test("merges new upstream commits into the local branch", () => {
    const { upstream, clone } = makeFixture();
    writeFileSync(join(upstream, "tool.ts"), "v2\n");
    commit(upstream, "tool v2");

    const result = update(clone);

    expect(result.status).toBe("merged"); // pushing is left to the user
    expect(git(clone, ["show", "HEAD:tool.ts"])).toBe("v2");
  });

  // The whole point of the guard: an update must never merge over someone's
  // uncommitted work.
  test("refuses on a dirty tree, before fetching anything", () => {
    const { upstream, clone } = makeFixture();
    writeFileSync(join(upstream, "tool.ts"), "v2\n");
    commit(upstream, "tool v2");
    writeFileSync(join(clone, "tool.ts"), "my local edit\n");

    expect(() => update(clone)).toThrow(/uncommitted changes/);
    expect(git(clone, ["show", "HEAD:tool.ts"])).toBe("v1");
    expect(git(clone, ["status", "--porcelain"])).toContain("tool.ts");
  });

  // Configuration lives in .env now, so the one file that used to conflict on
  // every single update isn't even tracked.
  test("a local .env is not part of the merge", () => {
    const { upstream, clone } = makeFixture();
    writeFileSync(join(upstream, ".env.example"), "GITHUB_REPO=\n");
    commit(upstream, "add .env.example");
    writeFileSync(join(clone, ".env"), "GITHUB_REPO=mine/skills\n");
    writeFileSync(join(clone, ".gitignore"), ".env\n");
    commit(clone, "ignore .env");

    const result = update(clone);

    expect(result.status).toBe("merged");
    expect(Bun.file(join(clone, ".env")).text()).resolves.toBe("GITHUB_REPO=mine/skills\n");
  });

  test("on a real conflict: stops with the file list and leaves the merge in place", () => {
    const { upstream, clone } = makeFixture();
    writeFileSync(join(upstream, "tool.ts"), "upstream change\n");
    commit(upstream, "upstream edit");
    writeFileSync(join(clone, "tool.ts"), "local change\n");
    commit(clone, "local edit");

    expect(() => update(clone)).toThrow(/conflicts you'll need to resolve/);
    // The half-done merge is deliberately left for the user to finish or abort.
    expect(git(clone, ["status", "--porcelain"])).toContain("tool.ts");
  });

  test("says how to add the upstream remote rather than inventing one", () => {
    const { clone } = makeFixture();
    git(clone, ["remote", "remove", "upstream"]);

    expect(() => update(clone)).toThrow(/git remote add upstream/);
  });
});
