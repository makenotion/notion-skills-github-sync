import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planMigration, repoFromOriginUrl, runMigrateConfig } from "../src/migrate-config.ts";

describe("planMigration", () => {
  test("maps every known key to its variable and keeps the value", () => {
    const { settings, unknownKeys } = planMigration(
      JSON.stringify({
        notionEnv: "dev",
        githubRepo: "acme/skills",
        githubBranch: "publish",
        skillsDatabaseId: "db-1",
        skillsDataSourceId: "ds-1",
        changeRequestsDataSourceId: "cr-1",
        pluginsDir: "packs",
        authorName: "Sync Bot",
        authorEmail: "bot@example.com",
      }),
    );

    expect(unknownKeys).toEqual([]);
    expect(settings).toEqual([
      ["NOTION_ENV", "dev"],
      ["GITHUB_REPO", "acme/skills"],
      ["GITHUB_BRANCH", "publish"],
      ["SKILLS_DATABASE_ID", "db-1"],
      ["SKILLS_DATA_SOURCE_ID", "ds-1"],
      ["CHANGE_REQUESTS_DATA_SOURCE_ID", "cr-1"],
      ["PLUGINS_DIR", "packs"],
      ["GIT_AUTHOR_NAME", "Sync Bot"],
      ["GIT_AUTHOR_EMAIL", "bot@example.com"],
    ]);
  });

  test("reports unknown keys and skips empty values", () => {
    const { settings, unknownKeys } = planMigration(
      JSON.stringify({ githubRepo: "acme/skills", githubBranch: "", mystery: "x" }),
    );
    expect(settings).toEqual([["GITHUB_REPO", "acme/skills"]]);
    expect(unknownKeys).toEqual(["mystery"]);
  });

  test("non-string values become their usual spellings", () => {
    const { settings } = planMigration(JSON.stringify({ injectUpdater: false }));
    expect(settings).toEqual([["INJECT_UPDATER", "false"]]);
  });

  test("rejects invalid JSON and non-objects with a plain message", () => {
    expect(() => planMigration("{ nope")).toThrow(/not valid JSON/);
    expect(() => planMigration('["a"]')).toThrow(/not a JSON object/);
  });
});

describe("repoFromOriginUrl", () => {
  test("understands https and ssh remotes, with and without .git", () => {
    expect(repoFromOriginUrl("https://github.com/acme/sync.git\n")).toBe("acme/sync");
    expect(repoFromOriginUrl("https://github.com/acme/sync")).toBe("acme/sync");
    expect(repoFromOriginUrl("git@github.com:acme/sync.git")).toBe("acme/sync");
  });

  test("refuses non-github remotes rather than guessing", () => {
    expect(repoFromOriginUrl("https://gitlab.com/acme/sync.git")).toBeUndefined();
  });
});

describe("runMigrateConfig", () => {
  const withConfig = (contents: string, env?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "skills-migrate-"));
    writeFileSync(join(dir, "config.json"), contents);
    if (env !== undefined) writeFileSync(join(dir, ".env"), env);
    return dir;
  };

  test("writes .env, sets one repo variable per setting (SKILLS_-prefixed where needed), then removes config.json", () => {
    const dir = withConfig(JSON.stringify({ githubRepo: "acme/skills", notionEnv: "dev" }));
    const calls: string[][] = [];
    runMigrateConfig({
      cwd: dir,
      repo: "acme/sync",
      log: () => {},
      exec: (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const env = readFileSync(join(dir, ".env"), "utf-8");
    expect(env).toContain("GITHUB_REPO=acme/skills");
    expect(env).toContain("NOTION_ENV=dev");
    // GitHub rejects GITHUB_* variable names; the workflow maps the prefix back.
    expect(calls).toEqual([
      ["gh", "variable", "set", "SKILLS_GITHUB_REPO", "--repo", "acme/sync", "--body", "acme/skills"],
      ["gh", "variable", "set", "NOTION_ENV", "--repo", "acme/sync", "--body", "dev"],
      ["git", "rm", "-f", "-q", "config.json"],
      [
        "git",
        "commit",
        "-q",
        "-m",
        "Remove config.json (settings migrated to environment variables)",
        "--",
        "config.json",
      ],
    ]);
  });

  test("falls back to a plain delete when config.json is not tracked by git", () => {
    const dir = withConfig(JSON.stringify({ githubRepo: "acme/skills" }));
    runMigrateConfig({
      cwd: dir,
      repo: "acme/sync",
      log: () => {},
      // gh succeeds; git rm fails as it would outside a repo / for an untracked file
      exec: (cmd) =>
        cmd === "git"
          ? { code: 128, stdout: "", stderr: "pathspec did not match" }
          : { code: 0, stdout: "", stderr: "" },
    });
    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });

  test("never overwrites a value .env already sets", () => {
    const dir = withConfig(
      JSON.stringify({ githubRepo: "legacy/skills", notionEnv: "dev" }),
      "GITHUB_REPO=mine/skills\n",
    );
    runMigrateConfig({ cwd: dir, envOnly: true, log: () => {} });

    const env = readFileSync(join(dir, ".env"), "utf-8");
    expect(env).toContain("GITHUB_REPO=mine/skills");
    expect(env).not.toContain("legacy/skills");
    expect(env).toContain("NOTION_ENV=dev");
  });

  test("--env-only runs no external commands and keeps config.json as the tripwire", () => {
    const dir = withConfig(JSON.stringify({ githubRepo: "acme/skills" }));
    runMigrateConfig({
      cwd: dir,
      envOnly: true,
      log: () => {},
      exec: () => {
        throw new Error("should not exec");
      },
    });
    expect(readFileSync(join(dir, ".env"), "utf-8")).toContain("GITHUB_REPO=acme/skills");
    // While the workflow's variables are unset, a leftover config.json is what
    // makes the deployment fail loudly instead of running on defaults.
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  });

  test("detects the sync repo from the origin remote when --repo is omitted", () => {
    const dir = withConfig(JSON.stringify({ githubRepo: "acme/skills" }));
    const calls: string[][] = [];
    runMigrateConfig({
      cwd: dir,
      log: () => {},
      exec: (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === "git") {
          return { code: 0, stdout: "git@github.com:acme/sync.git\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls[0]).toEqual(["git", "remote", "get-url", "origin"]);
    expect(calls[1]).toContain("SKILLS_GITHUB_REPO");
    expect(calls[1]).toContain("acme/sync");
  });

  test("a failed gh call names the variable instead of half-succeeding silently", () => {
    const dir = withConfig(JSON.stringify({ githubRepo: "acme/skills" }));
    expect(() =>
      runMigrateConfig({
        cwd: dir,
        repo: "acme/sync",
        log: () => {},
        exec: () => ({ code: 1, stdout: "", stderr: "HTTP 403" }),
      }),
    ).toThrow(/SKILLS_GITHUB_REPO: HTTP 403/);
    // The .env half still landed — the error is about the GitHub half only —
    // and config.json survives: the migration is not complete.
    expect(readFileSync(join(dir, ".env"), "utf-8")).toContain("GITHUB_REPO=acme/skills");
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  });

  test("a missing config.json is a plain error", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-migrate-"));
    expect(() => runMigrateConfig({ cwd: dir, log: () => {} })).toThrow(/nothing to migrate/);
  });
});
