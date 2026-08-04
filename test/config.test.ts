import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciVariableName,
  configJsonDeprecation,
  loadConfig,
  migrationPlan,
  parseBool,
} from "../src/config.ts";
import { mergeEnvFile } from "../src/setup/migrate-config.ts";

// A directory with no config.json, so tests exercise the env-only path unless
// they deliberately write one.
const emptyDir = mkdtempSync(join(tmpdir(), "skills-config-"));

const OWNED = [
  "GITHUB_REPO",
  "GITHUB_BRANCH",
  "NOTION_ENV",
  "NOTION_API_TOKEN",
  "PLUGINS_DIR",
  "INJECT_UPDATER",
  "AUTO_UPDATE",
  "SKILLS_DATA_SOURCE_ID",
  "GIT_AUTHOR_NAME",
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
    process.env.PLUGINS_DIR = "packs";
    process.env.INJECT_UPDATER = "false";
    process.env.AUTO_UPDATE = "no";

    const config = load();

    expect(config.github.repo).toBe("acme/skills");
    expect(config.github.branch).toBe("publish");
    expect(config.notion.env).toBe("dev");
    expect(config.notion.token).toBe("ntn_x");
    expect(config.sync).toMatchObject({
      notionEnv: "dev",
      pluginsDir: "packs",
      injectUpdater: false,
    });
    expect(config.autoUpdate).toBe(false);
  });

  test("defaults to prod, main, plugins, and the updater injected", () => {
    process.env.GITHUB_REPO = "acme/skills";

    const config = load();

    expect(config.notion.env).toBe("prod");
    expect(config.github.branch).toBe("main");
    expect(config.github.authorName).toBe("notion-skills-sync");
    expect(config.sync.pluginsDir).toBe("plugins");
    expect(config.sync.injectUpdater).toBe(true);
    expect(config.autoUpdate).toBe(true);
  });

  test("names the missing repo rather than failing obscurely later", () => {
    expect(() => load()).toThrow(/GITHUB_REPO/);
  });

  test("an empty variable is treated as unset, not as an empty setting", () => {
    process.env.GITHUB_REPO = "acme/skills";
    process.env.GITHUB_BRANCH = "   ";
    expect(load().github.branch).toBe("main");
  });

  describe("with a legacy config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-legacy-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        notionEnv: "dev",
        githubRepo: "legacy/skills",
        githubBranch: "legacy-branch",
        skillsDataSourceId: "ds-legacy",
        injectUpdater: false,
      }),
    );

    test("falls back to it key by key, but the environment wins", () => {
      process.env.GITHUB_BRANCH = "from-env";

      const config = load(dir);

      expect(config.github.branch).toBe("from-env"); // env wins
      expect(config.github.repo).toBe("legacy/skills"); // file fills the gap
      expect(config.notion.env).toBe("dev");
      expect(config.sync.skillsDataSourceId).toBe("ds-legacy");
      expect(config.sync.injectUpdater).toBe(false); // booleans too
    });

    test("warns once, naming the replacement variable for each key in play", () => {
      let warning = "";
      loadConfig({ cwd: dir, warn: (m) => (warning = m) });

      expect(warning).toContain("config.json is deprecated");
      expect(warning).toContain("githubRepo -> GITHUB_REPO");
      expect(warning).toContain("skillsDataSourceId -> SKILLS_DATA_SOURCE_ID");
      expect(warning).toContain("setup --migrate-config");
      // Only keys the file actually sets are listed.
      expect(warning).not.toContain("UPDATER_SLUG");
    });
  });

  test("a malformed config.json is an error, not a silent fallback to defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-broken-"));
    writeFileSync(join(dir, "config.json"), "{ nope");
    expect(() => load(dir)).toThrow(/Failed to parse config.json/);
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

describe("configJsonDeprecation", () => {
  test("lists nothing for an empty file", () => {
    const warning = configJsonDeprecation({});
    expect(warning).toContain("deprecated");
    expect(warning).not.toContain("->");
  });
});

describe("migrationPlan", () => {
  const plan = migrationPlan(
    {
      notionEnv: "dev",
      githubRepo: "acme/skills",
      githubBranch: "main",
      changeRequestsDataSourceId: "",
      authorName: "Sync Bot",
      injectUpdater: false,
    },
    { syncRepo: "acme/sync" },
  );

  test("emits an .env line per set value, and skips empty ones", () => {
    expect(plan.envLines).toContain("NOTION_ENV=dev");
    expect(plan.envLines).toContain("GITHUB_REPO=acme/skills");
    expect(plan.envLines).toContain("INJECT_UPDATER=false");
    expect(plan.envLines.some((l) => l.startsWith("CHANGE_REQUESTS_DATA_SOURCE_ID"))).toBe(false);
  });

  test("emits gh commands, quoting values that need it", () => {
    expect(plan.ghCommands).toContain("gh variable set NOTION_ENV --repo acme/sync --body dev");
    expect(plan.ghCommands).toContain(
      "gh variable set GIT_AUTHOR_NAME --repo acme/sync --body 'Sync Bot'",
    );
  });

  // GitHub rejects variable names starting with GITHUB_, so those two travel
  // under a prefix and the workflow maps them back.
  test("prefixes the two variables GitHub won't let us name directly", () => {
    expect(ciVariableName("GITHUB_REPO")).toBe("SKILLS_GITHUB_REPO");
    expect(ciVariableName("NOTION_ENV")).toBe("NOTION_ENV");
    expect(plan.ghCommands).toContain(
      "gh variable set SKILLS_GITHUB_REPO --repo acme/sync --body acme/skills",
    );
  });
});

describe("mergeEnvFile", () => {
  test("appends new keys and never overwrites one the file already sets", () => {
    const existing = "# mine\nGITHUB_REPO=already/set\n";
    const merged = mergeEnvFile(existing, ["# migrated", "GITHUB_REPO=other/repo", "NOTION_ENV=dev"]);

    expect(merged.skipped).toEqual(["GITHUB_REPO"]);
    expect(merged.written).toEqual(["NOTION_ENV"]);
    expect(merged.content).toContain("GITHUB_REPO=already/set");
    expect(merged.content).not.toContain("other/repo");
    expect(merged.content).toContain("NOTION_ENV=dev");
  });

  test("leaves the file untouched when there is nothing to add", () => {
    const existing = "NOTION_ENV=prod\n";
    const merged = mergeEnvFile(existing, ["# header", "NOTION_ENV=dev"]);
    expect(merged.content).toBe(existing);
    expect(merged.written).toEqual([]);
  });

  test("writes a fresh file with its header when there was none", () => {
    const merged = mergeEnvFile("", ["# header", "NOTION_ENV=dev"]);
    expect(merged.content).toBe("# header\nNOTION_ENV=dev\n");
  });
});
