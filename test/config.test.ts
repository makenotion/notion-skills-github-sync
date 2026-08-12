import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciVariableName, loadConfig, SYNC_CONCURRENCY } from "../src/config.ts";

// A directory with no config.json, so tests exercise the env-only path unless
// they deliberately write one.
const emptyDir = mkdtempSync(join(tmpdir(), "skills-config-"));

const OWNED = [
  "GITHUB_REPO",
  "GITHUB_BRANCH",
  "NOTION_ENV",
  "NOTION_API_TOKEN",
  "SKILLS_DATA_SOURCE_ID",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
];

// A developer's own .env is loaded into this process, so clear the settings
// under test on both sides of every case rather than trusting a clean slate.
const clearOwned = () => {
  for (const name of OWNED) delete process.env[name];
};
beforeEach(clearOwned);
afterEach(clearOwned);

const load = (cwd = emptyDir) => loadConfig({ cwd, warn: () => {} });

describe("loadConfig", () => {
  test("reads everything from the environment", () => {
    process.env.GITHUB_REPO = "acme/skills";
    process.env.GITHUB_BRANCH = "publish";
    process.env.NOTION_ENV = "dev";
    process.env.NOTION_API_TOKEN = "ntn_x";
    process.env.SKILLS_DATA_SOURCE_ID = "ds-1";
    process.env.GIT_AUTHOR_NAME = "Sync Bot";
    process.env.GIT_AUTHOR_EMAIL = "bot@example.com";

    const config = load();

    expect(config.github).toMatchObject({
      repo: "acme/skills",
      branch: "publish",
      authorName: "Sync Bot",
      authorEmail: "bot@example.com",
    });
    expect(config.notion.env).toBe("dev");
    expect(config.notion.token).toBe("ntn_x");
    expect(config.sync).toMatchObject({
      notionEnv: "dev",
      skillsDataSourceId: "ds-1",
    });
  });

  test("defaults every optional setting", () => {
    process.env.GITHUB_REPO = "acme/skills";

    const config = load();

    expect(config.notion.env).toBe("prod");
    expect(config.notion.token).toBeUndefined();
    expect(config.github.branch).toBe("main");
    expect(config.github.authorName).toBe("notion-skills-sync");
    expect(config.github.authorEmail).toBe("notion-skills-sync@users.noreply.github.com");
    expect(config.sync).toEqual({
      notionEnv: "prod",
      skillsDataSourceId: "",
      concurrency: SYNC_CONCURRENCY,
    });
  });

  test("names the missing repo rather than failing obscurely later", () => {
    expect(() => load()).toThrow(/GITHUB_REPO/);
  });

  test("an empty variable is treated as unset, not as an empty setting", () => {
    process.env.GITHUB_REPO = "acme/skills";
    process.env.GITHUB_BRANCH = "   ";
    process.env.NOTION_API_TOKEN = "";
    const config = load();
    expect(config.github.branch).toBe("main");
    expect(config.notion.token).toBeUndefined();
  });

});

// config.json is not a config source any more; a leftover one only changes the
// message a deployment gets, so nobody debugs an env-less run from scratch.
describe("a leftover config.json", () => {
  const withConfigJson = (contents: string) => {
    const dir = mkdtempSync(join(tmpdir(), "skills-legacy-"));
    writeFileSync(join(dir, "config.json"), contents);
    return dir;
  };

  test("with nothing in the environment, names the variables to set instead", () => {
    const dir = withConfigJson(
      JSON.stringify({ githubRepo: "legacy/skills", skillsDataSourceId: "ds-legacy" }),
    );

    expect(() => load(dir)).toThrow(/no longer read/);
    expect(() => load(dir)).toThrow(/githubRepo -> GITHUB_REPO/);
    expect(() => load(dir)).toThrow(/skillsDataSourceId -> SKILLS_DATA_SOURCE_ID/);
    expect(() => load(dir)).toThrow(/\.env\.example/);
    // Only keys the file actually sets are listed.
    expect(() => load(dir)).not.toThrow(/GIT_AUTHOR_NAME/);
  });

  test("keys whose setting no longer exists are not errors", () => {
    // pluginsDir, updaterSlug, … were retired outright: there is no variable to
    // set, so a file that only holds those must not block the sync.
    const dir = withConfigJson(
      JSON.stringify({ pluginsDir: "plugins", updaterSlug: "my-updater" }),
    );
    process.env.GITHUB_REPO = "acme/skills";

    let warning = "";
    const config = loadConfig({ cwd: dir, warn: (m) => (warning = m) });

    expect(config.github.repo).toBe("acme/skills");
    expect(warning).toContain("is ignored");
  });

  test("a partially migrated deployment errors instead of defaulting the rest", () => {
    const dir = withConfigJson(
      JSON.stringify({ githubRepo: "legacy/skills", githubBranch: "publish", notionEnv: "dev" }),
    );
    process.env.GITHUB_REPO = "acme/skills";

    expect(() => load(dir)).toThrow(/githubBranch -> GITHUB_BRANCH/);
    expect(() => load(dir)).toThrow(/notionEnv -> NOTION_ENV/);
    // Already migrated, so not listed.
    expect(() => load(dir)).not.toThrow(/githubRepo ->/);
  });

  test("an unparseable one still explains itself", () => {
    const dir = withConfigJson("{ nope");
    expect(() => load(dir)).toThrow(/no longer read/);
  });

  test("with the environment set, it is a warning and the env is used", () => {
    const dir = withConfigJson(JSON.stringify({ githubRepo: "legacy/skills" }));
    process.env.GITHUB_REPO = "acme/skills";

    let warning = "";
    const config = loadConfig({ cwd: dir, warn: (m) => (warning = m) });

    expect(config.github.repo).toBe("acme/skills");
    expect(warning).toContain("is ignored");
    expect(warning).toContain("Delete config.json");
  });
});

// GitHub rejects variable names starting with GITHUB_, so those two travel
// under a prefix and the workflow maps them back.
describe("ciVariableName", () => {
  test("prefixes the two variables GitHub won't let us name directly", () => {
    expect(ciVariableName("GITHUB_REPO")).toBe("SKILLS_GITHUB_REPO");
    expect(ciVariableName("GITHUB_BRANCH")).toBe("SKILLS_GITHUB_BRANCH");
    expect(ciVariableName("NOTION_ENV")).toBe("NOTION_ENV");
  });
});
