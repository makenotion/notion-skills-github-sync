// End-to-end sync tests: a fake Plugins API on one side, an in-memory target on
// the other, and the real HTTP client, archive reader, engine, planner, and
// layout in between. The unit under test is a whole plugin artifact.

import { describe, expect, test } from "bun:test";
import { NotionClient } from "../src/notion/index.ts";
import { runSync, type SyncSettings } from "../src/sync/engine.ts";
import { MemoryTarget } from "../src/target/memory.ts";
import { FakeSkillsApi, type FakePluginInit } from "./fake-skills-api.ts";

const SETTINGS: SyncSettings = {
  notionEnv: "dev",
  pluginsDir: "plugins",
  pluginSlug: "skills",
  skillsDatabaseId: "db-1",
  skillsDataSourceId: "ds-1",
  changeRequestsDataSourceId: "",
  injectUpdater: false,
  updaterSlug: "notion-skill-updater",
  concurrency: 4,
};

function client(api: FakeSkillsApi): NotionClient {
  return new NotionClient({
    auth: "ntn_test",
    baseUrl: "https://api.fake.notion",
    fetch: api.fetch,
    retry: { maxRetries: 3, initialRetryDelayMs: 1, maxRetryDelayMs: 5 },
  });
}

async function sync(
  api: FakeSkillsApi,
  target: MemoryTarget,
  settings: Partial<SyncSettings> = {},
  opts: { dryRun?: boolean } = {},
) {
  return await runSync({
    source: client(api),
    target,
    settings: { ...SETTINGS, ...settings },
    dryRun: opts.dryRun,
    log: () => {},
  });
}

const FINANCE: FakePluginInit[] = [
  {
    name: "Finance",
    description: "Finance team skills.",
    files: {
      "mcp.json": "{\n  \"server\": \"finance\"\n}\n",
      "commands/review.md": "# Review command\n",
    },
    skills: [{ title: "Expense Review" }, { title: "Budget Close" }],
  },
];

describe("whole-plugin publication", () => {
  test("publishes the archive opaquely and derives only Claude's compatibility manifest", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();

    const result = await sync(api, target);

    expect(result.committed).toBe(true);
    expect(result.plan.pluginSlugs).toEqual(["finance"]);
    expect(api.downloads).toHaveLength(1);
    expect(target.pathsUnder("plugins/finance/")).toEqual([
      "plugins/finance/.claude-plugin/plugin.json",
      "plugins/finance/.notion-sync.json",
      "plugins/finance/commands/review.md",
      "plugins/finance/mcp.json",
      "plugins/finance/plugin.json",
      "plugins/finance/skills/budget-close/SKILL.md",
      "plugins/finance/skills/expense-review/SKILL.md",
    ]);

    expect(target.json<Record<string, unknown>>("plugins/finance/plugin.json")).toEqual({
      $schema: "https://agent-plugins.org/schema/1.0.0/plugin.json",
      name: "finance",
    });
    expect(target.json<Record<string, unknown>>("plugins/finance/.claude-plugin/plugin.json")).toEqual({
      $schema: "https://agent-plugins.org/schema/1.0.0/plugin.json",
      name: "finance",
      version: "1.0.0",
      description: "Finance team skills.",
      author: { name: "Finance" },
    });
    expect(target.has("plugins/finance/.cursor-plugin/plugin.json")).toBe(false);
    expect(target.has("plugins/finance/.codex-plugin/plugin.json")).toBe(false);
    expect(target.text("plugins/finance/mcp.json")).toContain("finance");
    expect(target.text("plugins/finance/commands/review.md")).toContain("Review command");

    expect(target.json<Record<string, unknown>>("plugins/finance/.notion-sync.json")).toEqual({
      source: "notion",
      syncedBy: "notion-skills-github-sync",
      layoutVersion: 1,
      notion: {
        env: "dev",
        databaseId: "db-1",
        skillsDataSourceId: "ds-1",
        pluginId: "00000001-0000-4000-8000-000000000001",
        url: "https://app.dev.notion.com/p/00000001000040008000000000000001",
        versionId: "pv-1-v1-v1",
      },
      plugin: { slug: "finance", name: "Finance" },
    });
  });

  test("keeps each client's marketplace shape", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();
    await sync(api, target);

    const claude = target.json<{ plugins: Array<Record<string, unknown>> }>(
      ".claude-plugin/marketplace.json",
    );
    expect(claude.plugins).toEqual([
      { name: "finance", source: "./plugins/finance", description: "Finance team skills." },
    ]);
    expect(
      target.json<{ plugins: unknown[] }>(".cursor-plugin/marketplace.json").plugins,
    ).toEqual(claude.plugins);
    expect(target.json<{ plugins: unknown[] }>(".agents/plugins/marketplace.json").plugins).toEqual([
      {
        name: "finance",
        source: { source: "local", path: "./plugins/finance" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ]);
  });

  test("publishes a plugin with no skills because the plugin is the unit", async () => {
    const api = new FakeSkillsApi([{ name: "Commands", files: { "commands/go.md": "go" }, skills: [] }]);
    const target = new MemoryTarget();

    const result = await sync(api, target);

    expect(result.plan.pluginSlugs).toEqual(["commands"]);
    expect(target.has("plugins/commands/plugin.json")).toBe(true);
    expect(target.has("plugins/commands/commands/go.md")).toBe(true);
  });

  test("expands each skill's single attached zip while leaving the rest opaque", async () => {
    const binary = new Uint8Array([0, 1, 2, 255]);
    const api = new FakeSkillsApi([
      {
        name: "Tools",
        files: { "mcp.json": "{}" },
        skills: [
          {
            title: "Runner",
            zip: {
              "scripts/run.py": "print('hi')\n",
              "assets/blob.bin": binary,
              "SKILL.md": "stale zip copy",
            },
          },
        ],
      },
    ]);
    const target = new MemoryTarget();

    await sync(api, target);

    expect(target.has("plugins/tools/skills/runner/files.zip")).toBe(false);
    expect(target.text("plugins/tools/skills/runner/scripts/run.py")).toContain("print");
    expect(target.bytes("plugins/tools/skills/runner/assets/blob.bin")).toEqual(binary);
    expect(target.text("plugins/tools/skills/runner/SKILL.md")).not.toContain("stale zip copy");
    expect(target.has("plugins/tools/mcp.json")).toBe(true);
  });

  test("injects a standard updater plugin plus Claude's compatibility copy", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();

    await sync(api, target, { injectUpdater: true, changeRequestsDataSourceId: "cr-1" });

    expect(target.pathsUnder("plugins/notion-skill-updater/")).toEqual([
      "plugins/notion-skill-updater/.claude-plugin/plugin.json",
      "plugins/notion-skill-updater/plugin.json",
      "plugins/notion-skill-updater/skills/notion-skill-updater/SKILL.md",
    ]);
    expect(target.text("plugins/notion-skill-updater/.claude-plugin/plugin.json")).toBe(
      target.text("plugins/notion-skill-updater/plugin.json"),
    );
    expect(
      target.json<{ mcpServers: Record<string, { url: string }> }>(
        "plugins/notion-skill-updater/plugin.json",
      ).mcpServers["notion-dev"]!.url,
    ).toBe("https://mcp-dev.notion.com/mcp");
  });
});

describe("plugin lifecycle", () => {
  test("uses version_id as the complete warm-cache key", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();
    await sync(api, target);
    const builds = api.pluginArchiveBuilds.length;

    const result = await sync(api, target);

    expect(result.committed).toBe(false);
    expect(result.plan.retainedPlugins).toEqual(["finance"]);
    expect(api.pluginArchiveBuilds).toHaveLength(builds);
    expect(target.commits).toHaveLength(1);
  });

  test("does not inspect or heal repository drift for an unchanged plugin", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();
    await sync(api, target);
    target.files.set(
      "plugins/finance/skills/expense-review/SKILL.md",
      new TextEncoder().encode("locally changed\n"),
    );

    const result = await sync(api, target);

    expect(result.committed).toBe(false);
    expect(target.text("plugins/finance/skills/expense-review/SKILL.md")).toBe("locally changed\n");
  });

  test("replaces a changed plugin directory exactly", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();
    await sync(api, target);
    api.setPluginFile("Finance", "commands/new.md", "# New\n");
    api.deletePluginFile("Finance", "commands/review.md");

    const result = await sync(api, target);

    expect(result.committed).toBe(true);
    expect(target.has("plugins/finance/commands/review.md")).toBe(false);
    expect(target.text("plugins/finance/commands/new.md")).toBe("# New\n");
    expect(target.has("plugins/finance/mcp.json")).toBe(true);
    expect(target.commits[1]!.deleted).toContain("plugins/finance/commands/review.md");
  });

  test("removes a plugin that disappears from the listing", async () => {
    const api = new FakeSkillsApi([
      ...FINANCE,
      { name: "EPD", skills: [{ title: "Design Review" }] },
    ]);
    const target = new MemoryTarget();
    await sync(api, target);
    api.deletePlugin("EPD");

    const result = await sync(api, target);

    expect(result.plan.prunedSlugs).toEqual(["epd"]);
    expect(target.pathsUnder("plugins/epd/")).toEqual([]);
    expect(
      target
        .json<{ plugins: Array<{ name: string }> }>(".claude-plugin/marketplace.json")
        .plugins.map((plugin) => plugin.name),
    ).toEqual(["finance"]);
  });

  test("a dry run resolves the full plugin plan without writing", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();

    const result = await sync(api, target, {}, { dryRun: true });

    expect(result.committed).toBe(false);
    expect(result.plan.pluginSlugs).toEqual(["finance"]);
    expect(result.plan.changes.write.length).toBeGreaterThan(0);
    expect(target.paths()).toEqual([]);
  });
});

describe("plugin API behavior", () => {
  test("follows plugin-list pagination", async () => {
    const api = new FakeSkillsApi(
      [
        { name: "Finance", skills: [{ title: "Expense Review" }] },
        { name: "EPD", skills: [{ title: "Design Review" }] },
        { name: "Sales", skills: [{ title: "Deal Desk" }] },
      ],
      { pageSize: 1 },
    );
    const target = new MemoryTarget();

    const result = await sync(api, target);

    expect(result.plan.pluginSlugs).toEqual(["finance", "epd", "sales"]);
    expect(
      api.requests.filter((path) => path === "/v1/ai/plugins" || path.startsWith("/v1/ai/plugins?")),
    ).toEqual([
      "/v1/ai/plugins",
      "/v1/ai/plugins?start_cursor=1",
      "/v1/ai/plugins?start_cursor=2",
    ]);
  });

  test("retains an existing plugin only for directory_not_found", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();
    await sync(api, target);
    const oldMarker = target.text("plugins/finance/.notion-sync.json");
    api.setPluginFile("Finance", "commands/new.md", "new");
    const id = api.plugin("Finance").id;
    api.failNext({
      status: 404,
      body: { code: "directory_not_found", message: "not shared by the connected workspace" },
      pathIncludes: `/v1/ai/plugins/${id}`,
    });

    const result = await sync(api, target);

    expect(result.committed).toBe(false);
    expect(result.plan.retainedPlugins).toEqual(["finance"]);
    expect(target.text("plugins/finance/.notion-sync.json")).toBe(oldMarker);
    expect(target.has("plugins/finance/commands/new.md")).toBe(false);
  });

  test("does not publish a never-downloaded plugin whose archive is unavailable", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();
    const id = api.plugin("Finance").id;
    api.failNext({
      status: 404,
      body: { code: "directory_not_found", message: "not shared" },
      pathIncludes: `/v1/ai/plugins/${id}`,
    });

    const result = await sync(api, target);

    expect(result.plan.pluginSlugs).toEqual([]);
    expect(target.pathsUnder("plugins/finance/")).toEqual([]);
  });

  test("fails on any other archive error", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const target = new MemoryTarget();
    api.failNext({
      status: 404,
      body: { code: "object_not_found", message: "gone" },
      pathIncludes: "/v1/ai/plugins/",
    });

    await expect(sync(api, target)).rejects.toThrow(/object_not_found/);
    expect(target.commits).toHaveLength(0);
  });

  test("keeps the archive response plugin-shaped", async () => {
    const api = new FakeSkillsApi(FINANCE);
    const notion = client(api);
    const [plugin] = await notion.plugins.listAll();

    const { files } = await notion.plugins.files({ plugin_id: plugin!.id });

    expect(Object.keys(files).sort()).toEqual([
      "commands/review.md",
      "mcp.json",
      "plugin.json",
      "skills/budget-close/SKILL.md",
      "skills/expense-review/SKILL.md",
    ]);
    expect(api.downloads).toHaveLength(1);
  });
});

test("commit reporting is plugin-oriented", async () => {
  const api = new FakeSkillsApi(FINANCE);
  const target = new MemoryTarget();
  await sync(api, target);

  expect(target.commits[0]!.message).toContain("notion-skills sync: 1 plugin(s)");
  expect(target.commits[0]!.message).not.toContain("skill(s)");
  expect(target.commits[0]!.message).toContain("Plugins: finance");
});
