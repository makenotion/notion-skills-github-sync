import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciVariableName,
  loadConfig,
  parseBool,
  parseConcurrency,
  DEFAULT_SYNC_CONCURRENCY,
} from "../src/config.ts";

// A directory with no config.json, so tests exercise the env-only path unless
// they deliberately write one.
const emptyDir = mkdtempSync(join(tmpdir(), "skills-config-"));

const OWNED = [
  "GITHUB_REPO",
  "GITHUB_BRANCH",
  "NOTION_ENV",
  "NOTION_API_TOKEN",
  "NOTION_BASE_URL",
  "PLUGINS_DIR",
  "PLUGIN_SLUG",
  "INJECT_UPDATER",
  "UPDATER_SLUG",
  "SKILLS_DATABASE_ID",
  "SKILLS_DATA_SOURCE_ID",
  "CHANGE_REQUESTS_DATA_SOURCE_ID",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "SYNC_CONCURRENCY",
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
    process.env.NOTION_BASE_URL = "http://localhost:3000";
    process.env.PLUGINS_DIR = "packs";
    process.env.PLUGIN_SLUG = "team";
    process.env.SKILLS_DATABASE_ID = "db-1";
    process.env.SKILLS_DATA_SOURCE_ID = "ds-1";
    process.env.CHANGE_REQUESTS_DATA_SOURCE_ID = "cr-1";
    process.env.GIT_AUTHOR_NAME = "Sync Bot";
    process.env.GIT_AUTHOR_EMAIL = "bot@example.com";
    process.env.INJECT_UPDATER = "false";
    process.env.UPDATER_SLUG = "updater";

    const config = load();

    expect(config.github).toMatchObject({
      repo: "acme/skills",
      branch: "publish",
      authorName: "Sync Bot",
      authorEmail: "bot@example.com",
    });
    expect(config.notion.env).toBe("dev");
    expect(config.notion.token).toBe("ntn_x");
    expect(config.notion.baseUrl).toBe("http://localhost:3000");
    expect(config.sync).toMatchObject({
      notionEnv: "dev",
      pluginsDir: "packs",
      pluginSlug: "team",
      skillsDatabaseId: "db-1",
      skillsDataSourceId: "ds-1",
      changeRequestsDataSourceId: "cr-1",
      injectUpdater: false,
      updaterSlug: "updater",
    });
  });

  test("defaults every optional setting", () => {
    process.env.GITHUB_REPO = "acme/skills";

    const config = load();

    expect(config.notion.env).toBe("prod");
    expect(config.notion.token).toBeUndefined();
    expect(config.notion.baseUrl).toBeUndefined();
    expect(config.github.branch).toBe("main");
    expect(config.github.authorName).toBe("notion-skills-sync");
    expect(config.github.authorEmail).toBe("notion-skills-sync@users.noreply.github.com");
    expect(config.sync).toMatchObject({
      notionEnv: "prod",
      pluginsDir: "plugins",
      pluginSlug: "skills",
      skillsDatabaseId: "",
      skillsDataSourceId: "",
      changeRequestsDataSourceId: "",
      injectUpdater: true,
      updaterSlug: "notion-skill-updater",
      concurrency: DEFAULT_SYNC_CONCURRENCY,
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

  test("honours SYNC_CONCURRENCY", () => {
    process.env.GITHUB_REPO = "acme/skills";
    process.env.SYNC_CONCURRENCY = "3";
    expect(load().sync.concurrency).toBe(3);
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
    expect(() => load(dir)).not.toThrow(/UPDATER_SLUG/);
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

describe("parseBool", () => {
  test("accepts the usual spellings", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) expect(parseBool(v, false)).toBe(true);
    for (const v of ["0", "false", "no", "off"]) expect(parseBool(v, true)).toBe(false);
  });

  test("undefined falls back; nonsense is an error rather than a silent false", () => {
    expect(parseBool(undefined, true)).toBe(true);
    expect(() => parseBool("maybe", true)).toThrow(/boolean/);
  });
});

describe("parseConcurrency", () => {
  test("undefined falls back; a positive integer is taken as-is", () => {
    expect(parseConcurrency(undefined, DEFAULT_SYNC_CONCURRENCY)).toBe(DEFAULT_SYNC_CONCURRENCY);
    expect(parseConcurrency(" 12 ", 8)).toBe(12);
  });

  test("rejects values that would silently cripple or stall a cold sync", () => {
    for (const v of ["0", "-1", "3.5", "eight", ""]) {
      expect(() => parseConcurrency(v, 8)).toThrow(/positive integer/);
    }
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
