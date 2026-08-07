import { describe, expect, test } from "bun:test";
import { CONFIG_ENV_VARS, resolveConfig } from "../src/config.ts";

describe("resolveConfig", () => {
  test("reads all values from config.json when no env vars are set", () => {
    const cfg = resolveConfig(
      {
        notionEnv: "dev",
        skillsDataSourceId: "ds-file",
        skillsDatabaseId: "db-file",
        changeRequestsDataSourceId: "cr-file",
        githubRepo: "owner/from-file",
        githubBranch: "trunk",
        pluginsDir: "plug",
        authorName: "File Author",
        authorEmail: "file@example.com",
        updaterSlug: "custom-updater",
      },
      {},
    );
    expect(cfg.notionEnv).toBe("dev");
    expect(cfg.skillsDataSourceId).toBe("ds-file");
    expect(cfg.skillsDatabaseId).toBe("db-file");
    expect(cfg.changeRequestsDataSourceId).toBe("cr-file");
    expect(cfg.githubRepo).toBe("owner/from-file");
    expect(cfg.githubBranch).toBe("trunk");
    expect(cfg.pluginsDir).toBe("plug");
    expect(cfg.authorName).toBe("File Author");
    expect(cfg.authorEmail).toBe("file@example.com");
    expect(cfg.updaterSlug).toBe("custom-updater");
    expect(cfg.injectUpdater).toBe(true);
  });

  test("environment variables override config.json", () => {
    const cfg = resolveConfig(
      { skillsDataSourceId: "ds-file", githubRepo: "owner/from-file" },
      {
        [CONFIG_ENV_VARS.skillsDataSourceId]: "ds-env",
        [CONFIG_ENV_VARS.githubRepo]: "owner/from-env",
        [CONFIG_ENV_VARS.githubBranch]: "release",
      },
    );
    expect(cfg.skillsDataSourceId).toBe("ds-env");
    expect(cfg.githubRepo).toBe("owner/from-env");
    expect(cfg.githubBranch).toBe("release");
  });

  test("works with NO config.json (env vars only — the deployment path)", () => {
    const cfg = resolveConfig(
      {},
      {
        [CONFIG_ENV_VARS.skillsDataSourceId]: "ds-env",
        [CONFIG_ENV_VARS.githubRepo]: "owner/deployed",
      },
    );
    expect(cfg.skillsDataSourceId).toBe("ds-env");
    expect(cfg.githubRepo).toBe("owner/deployed");
    // Defaults still apply.
    expect(cfg.notionEnv).toBe("prod");
    expect(cfg.githubBranch).toBe("main");
    expect(cfg.pluginsDir).toBe("plugins");
    expect(cfg.injectUpdater).toBe(true);
  });

  test("throws a helpful error when required values are missing everywhere", () => {
    expect(() => resolveConfig({}, {})).toThrow(/skillsDataSourceId/);
    expect(() =>
      resolveConfig({ skillsDataSourceId: "ds" }, {}),
    ).toThrow(/githubRepo/);
  });

  test("blank env vars fall back to config.json (empty string is not a value)", () => {
    const cfg = resolveConfig(
      { skillsDataSourceId: "ds-file", githubRepo: "owner/from-file" },
      {
        [CONFIG_ENV_VARS.skillsDataSourceId]: "   ",
        [CONFIG_ENV_VARS.githubBranch]: "",
      },
    );
    expect(cfg.skillsDataSourceId).toBe("ds-file");
    expect(cfg.githubBranch).toBe("main");
  });

  test("injectUpdater can be disabled via env or file", () => {
    expect(
      resolveConfig(
        { skillsDataSourceId: "ds", githubRepo: "o/r" },
        { [CONFIG_ENV_VARS.injectUpdater]: "false" },
      ).injectUpdater,
    ).toBe(false);
    expect(
      resolveConfig(
        { skillsDataSourceId: "ds", githubRepo: "o/r", injectUpdater: false },
        {},
      ).injectUpdater,
    ).toBe(false);
  });
});
