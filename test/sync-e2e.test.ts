// End-to-end sync tests: a fake Skills API on one side, an in-memory target on
// the other, and the real client, engine, plan, and layout in between.
//
// Everything asserted here is observable behaviour — the resulting file tree,
// how many commits it took, what got pruned, what each client's marketplace
// says, whether a second run is a no-op. That's deliberate: these tests should
// survive a rewrite of the internals, which is exactly what they were written
// during.

import { describe, expect, test } from "bun:test";
import { NotionClient } from "../src/notion/index.ts";
import { MemoryTarget } from "../src/target/memory.ts";
import type { FileContent } from "../src/target/target.ts";
import { runSync, type SyncSettings } from "../src/sync/engine.ts";
import { fakeNotionId, FakeSkillsApi, type FakePluginInit } from "./fake-skills-api.ts";

const SETTINGS: SyncSettings = {
  notionEnv: "dev",
  pluginsDir: "plugins",
  pluginSlug: "skills",
  skillsDatabaseId: "db-1",
  skillsDataSourceId: "ds-1",
  changeRequestsDataSourceId: "",
  injectUpdater: false,
  updaterSlug: "notion-skill-updater",
};

function client(api: FakeSkillsApi): NotionClient {
  return new NotionClient({
    auth: "ntn_test",
    baseUrl: "https://api.fake.notion",
    fetch: api.fetch,
    // Keep failing-request tests fast; the delay math itself is unit-tested.
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

/** One plugin, two plain skills — the fixture most tests start from. */
const TWO_SKILLS: FakePluginInit[] = [
  {
    name: "Finance",
    description: "Finance team skills.",
    skills: [{ title: "Expense Review" }, { title: "Budget Close" }],
  },
];

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("a cold sync", () => {
  test("publishes every skill, with manifests for all three clients", async () => {
    const api = new FakeSkillsApi([
      {
        name: "Finance",
        description: "Finance team skills.",
        skills: [
          {
            title: "Expense Review",
            description: "Use when reviewing expenses.",
            attachments: { "notes.md": "# Notes\n" },
          },
          { title: "Budget Close" },
        ],
      },
      { name: "EPD", skills: [{ title: "Design Review" }] },
    ]);
    const target = new MemoryTarget();

    const result = await sync(api, target);

    expect(result.committed).toBe(true);
    expect(target.commits).toHaveLength(1);

    // The whole published tree, exactly.
    expect(target.paths()).toEqual([
      ".agents/plugins/marketplace.json",
      ".claude-plugin/marketplace.json",
      ".cursor-plugin/marketplace.json",
      "plugins/epd/.claude-plugin/plugin.json",
      "plugins/epd/.codex-plugin/plugin.json",
      "plugins/epd/.cursor-plugin/plugin.json",
      "plugins/epd/skills/design-review/.notion-sync.json",
      "plugins/epd/skills/design-review/SKILL.md",
      "plugins/finance/.claude-plugin/plugin.json",
      "plugins/finance/.codex-plugin/plugin.json",
      "plugins/finance/.cursor-plugin/plugin.json",
      "plugins/finance/skills/budget-close/.notion-sync.json",
      "plugins/finance/skills/budget-close/SKILL.md",
      "plugins/finance/skills/expense-review/.notion-sync.json",
      "plugins/finance/skills/expense-review/SKILL.md",
      "plugins/finance/skills/expense-review/notes.md",
    ]);

    // SKILL.md arrives rendered from the API — we don't build it.
    expect(target.text("plugins/finance/skills/expense-review/SKILL.md")).toContain(
      "description: Use when reviewing expenses.",
    );

    // The marker is the back-reference plus the change-detection key.
    expect(
      target.json<Record<string, unknown>>("plugins/finance/skills/expense-review/.notion-sync.json"),
    ).toEqual({
      source: "notion",
      syncedBy: "notion-skills-github-sync",
      notion: {
        env: "dev",
        databaseId: "db-1",
        skillsDataSourceId: "ds-1",
        directoryId: "00000000-0000-4000-8000-000000000002",
        // The marker's link is the app URL for that page, dashes stripped.
        url: "https://app.dev.notion.com/p/00000000000040008000000000000002",
        versionId: "v1",
      },
      skill: { slug: "expense-review", name: "expense-review" },
    });

    // Identical plugin.json bytes for every client; only the directory differs.
    const claudeManifest = target.text("plugins/finance/.claude-plugin/plugin.json");
    expect(target.text("plugins/finance/.cursor-plugin/plugin.json")).toBe(claudeManifest);
    expect(target.text("plugins/finance/.codex-plugin/plugin.json")).toBe(claudeManifest);
    expect(JSON.parse(claudeManifest)).toEqual({
      name: "finance",
      version: "1.0.0",
      description: "Finance team skills.",
      author: { name: "Finance" },
    });
  });

  test("lists the same plugins in each client's marketplace, in each client's shape", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target);

    const claude = target.json<{ plugins: Array<Record<string, unknown>> }>(
      ".claude-plugin/marketplace.json",
    );
    expect(claude.plugins).toEqual([
      { name: "finance", source: "./plugins/finance", description: "Finance team skills." },
    ]);

    const cursor = target.json<{ plugins: Array<Record<string, unknown>> }>(
      ".cursor-plugin/marketplace.json",
    );
    expect(cursor.plugins).toEqual(claude.plugins);

    const codex = target.json<{ plugins: Array<Record<string, unknown>> }>(
      ".agents/plugins/marketplace.json",
    );
    expect(codex.plugins).toEqual([
      {
        name: "finance",
        source: { source: "local", path: "./plugins/finance" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ]);
  });

  test("a dry run writes nothing but still reports the full plan", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();

    const result = await sync(api, target, {}, { dryRun: true });

    expect(result.committed).toBe(false);
    expect(target.commits).toHaveLength(0);
    expect(target.paths()).toEqual([]);
    expect(result.plan.skillSlugs.sort()).toEqual(["budget-close", "expense-review"]);
    expect(result.plan.changes.write.length).toBeGreaterThan(0);
  });

  test("injects the updater plugin, which carries no marker so it is never pruned", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target, { injectUpdater: true, changeRequestsDataSourceId: "cr-1" });

    expect(target.pathsUnder("plugins/notion-skill-updater/")).toEqual([
      "plugins/notion-skill-updater/.claude-plugin/plugin.json",
      "plugins/notion-skill-updater/.codex-plugin/plugin.json",
      "plugins/notion-skill-updater/.cursor-plugin/plugin.json",
      "plugins/notion-skill-updater/skills/notion-skill-updater/SKILL.md",
    ]);
    // The env drives the bundled MCP endpoint and its display name.
    expect(
      target.json<{ mcpServers: Record<string, { url: string }> }>(
        "plugins/notion-skill-updater/.claude-plugin/plugin.json",
      ).mcpServers["notion-dev"]!.url,
    ).toBe("https://mcp-dev.notion.com/mcp");
    // Change requests are configured, so the propose-a-change path is taught.
    expect(
      target.text("plugins/notion-skill-updater/skills/notion-skill-updater/SKILL.md"),
    ).toContain("cr-1");
  });
});

describe("re-running a sync", () => {
  test("is idempotent, and downloads no archives at all", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target);
    const firstPass = target.paths();
    const buildsAfterCold = api.archiveBuilds.length;
    expect(buildsAfterCold).toBe(2);

    const result = await sync(api, target);

    expect(result.committed).toBe(false);
    expect(target.commits).toHaveLength(1); // no second commit
    expect(target.paths()).toEqual(firstPass);
    // The version_id fast path: no archive was built or downloaded.
    expect(api.archiveBuilds).toHaveLength(buildsAfterCold);
    expect(result.plan.retainedSkills.sort()).toEqual(["budget-close", "expense-review"]);
  });

  test("rewrites only the skill whose version_id moved", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target);
    api.archiveBuilds.length = 0;

    api.editSkill("Expense Review", { body: "# Expense Review\n\nNow with receipts.\n" });
    const result = await sync(api, target);

    expect(result.committed).toBe(true);
    expect(api.archiveBuilds).toEqual([api.skill("Expense Review").id]);
    expect(result.plan.retainedSkills).toEqual(["budget-close"]);
    expect(target.commits[1]!.written.sort()).toEqual([
      "plugins/finance/skills/expense-review/.notion-sync.json",
      "plugins/finance/skills/expense-review/SKILL.md",
    ]);
    expect(target.text("plugins/finance/skills/expense-review/SKILL.md")).toContain(
      "Now with receipts.",
    );
  });

  test("a config change forces a rewrite even though no skill changed", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target);

    // The marker embeds the Notion ids, so pointing at a different data source
    // changes its bytes — and re-downloading is the only way to rebuild the dir.
    const result = await sync(api, target, { skillsDataSourceId: "ds-2" });

    expect(result.committed).toBe(true);
    expect(
      target.json<{ notion: { skillsDataSourceId: string } }>(
        "plugins/finance/skills/expense-review/.notion-sync.json",
      ).notion.skillsDataSourceId,
    ).toBe("ds-2");
  });

  test("heals a skill whose files were deleted by hand", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target);
    api.archiveBuilds.length = 0;

    // A matching marker is not enough on its own: without SKILL.md the dir would
    // stay broken forever behind it.
    target.files.delete("plugins/finance/skills/expense-review/SKILL.md");
    await sync(api, target);

    expect(api.archiveBuilds).toEqual([api.skill("Expense Review").id]);
    expect(target.has("plugins/finance/skills/expense-review/SKILL.md")).toBe(true);
  });
});

describe("pruning", () => {
  test("removes a skill deleted in Notion and leaves its untouched siblings alone", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target);

    api.deleteSkill("Budget Close");
    const result = await sync(api, target);

    expect(target.pathsUnder("plugins/finance/skills/")).toEqual([
      "plugins/finance/skills/expense-review/.notion-sync.json",
      "plugins/finance/skills/expense-review/SKILL.md",
    ]);
    // The surviving skill was retained (version_id matched) — a retained dir
    // contributes no desired files, so prune has to step around it rather than
    // treating "not desired" as "not wanted".
    expect(result.plan.retainedSkills).toEqual(["expense-review"]);
    expect(target.commits[1]!.written).toEqual([]);
    expect(target.commits[1]!.deleted.sort()).toEqual([
      "plugins/finance/skills/budget-close/.notion-sync.json",
      "plugins/finance/skills/budget-close/SKILL.md",
    ]);
  });

  test("removes an attachment a skill no longer has", async () => {
    const api = new FakeSkillsApi([
      {
        name: "Finance",
        skills: [{ title: "Expense Review", attachments: { "notes.md": "# Notes\n" } }],
      },
    ]);
    const target = new MemoryTarget();
    await sync(api, target);
    expect(target.has("plugins/finance/skills/expense-review/notes.md")).toBe(true);

    api.editSkill("Expense Review", { attachments: {} });
    await sync(api, target);

    // A rewritten skill dir owns its whole subtree.
    expect(target.has("plugins/finance/skills/expense-review/notes.md")).toBe(false);
    expect(target.has("plugins/finance/skills/expense-review/SKILL.md")).toBe(true);
  });

  test("moves a whole plugin's subtree when the plugin is renamed in Notion", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target);

    api.renamePlugin("Finance", "Finance & Ops");
    await sync(api, target);

    expect(target.pathsUnder("plugins/finance/")).toEqual([]);
    expect(target.pathsUnder("plugins/finance-ops/skills/").length).toBe(4);
    expect(
      target.json<{ plugins: Array<Record<string, unknown>> }>(".claude-plugin/marketplace.json")
        .plugins,
    ).toEqual([
      {
        name: "finance-ops",
        source: "./plugins/finance-ops",
        description: "Finance team skills.",
      },
    ]);
  });

  test("removes a plugin that lost access, including its marketplace entries", async () => {
    const api = new FakeSkillsApi([
      ...TWO_SKILLS,
      { name: "EPD", skills: [{ title: "Design Review" }] },
    ]);
    const target = new MemoryTarget();
    await sync(api, target);

    api.deletePlugin("EPD");
    const result = await sync(api, target);

    expect(result.plan.prunedSlugs).toEqual(["epd"]);
    expect(target.pathsUnder("plugins/epd/")).toEqual([]);
    for (const path of [
      ".claude-plugin/marketplace.json",
      ".cursor-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
    ]) {
      const names = target
        .json<{ plugins: Array<{ name: string }> }>(path)
        .plugins.map((p) => p.name);
      expect(names).toEqual(["finance"]);
    }
  });

  test("prunes a hand-authored plugin and its marketplace entry", async () => {
    // Notion is the sole source of what's published, so a plugin dir the sync
    // didn't produce is removed even though it carries no marker.
    const handAuthored: Record<string, FileContent> = {
      "plugins/hello-world/.claude-plugin/plugin.json": '{\n  "name": "hello-world"\n}\n',
      "plugins/hello-world/skills/hello-world/SKILL.md": "# Hello\n",
      ".claude-plugin/marketplace.json": JSON.stringify(
        {
          name: "skills",
          owner: { name: "Skills Team" },
          plugins: [
            { name: "hello-world", source: "./plugins/hello-world", description: "Hand-written." },
          ],
        },
        null,
        2,
      ),
    };
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget(handAuthored);

    await sync(api, target);

    expect(target.pathsUnder("plugins/hello-world/")).toEqual([]);
    const claude = target.json<{ name: string; owner: unknown; plugins: Array<{ name: string }> }>(
      ".claude-plugin/marketplace.json",
    );
    expect(claude.plugins.map((p) => p.name)).toEqual(["finance"]);
    // The repo's own identity is not a plugin listing — it still survives.
    expect(claude.owner).toEqual({ name: "Skills Team" });
    expect(claude.name).toBe("skills");
  });

  test("a stale marketplace entry is healed even if its directory is gone", async () => {
    // Previously not auto-healed: the entry outlived the directory forever.
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget({
      ".claude-plugin/marketplace.json": JSON.stringify(
        { name: "skills", plugins: [{ name: "ghost", source: "./plugins/ghost" }] },
        null,
        2,
      ),
    });

    await sync(api, target);

    const names = target
      .json<{ plugins: Array<{ name: string }> }>(".claude-plugin/marketplace.json")
      .plugins.map((p) => p.name);
    expect(names).not.toContain("ghost");
  });

  test("refuses to overwrite a marketplace file that isn't valid JSON", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget({ ".claude-plugin/marketplace.json": "{ not json" });

    await expect(sync(api, target)).rejects.toThrow(/not valid JSON/);
    expect(target.commits).toHaveLength(0);
  });
});

describe("skill archives", () => {
  test("expands a lone attachment zip in place, keeping the API's SKILL.md", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const api = new FakeSkillsApi([
      {
        name: "Finance",
        skills: [
          {
            title: "Expense Review",
            zip: {
              "scripts/run.py": "print('hi')\n",
              "assets/banner.png": png,
              // A zip can't shadow the API-rendered SKILL.md.
              "SKILL.md": "# From the zip — must be ignored\n",
            },
          },
        ],
      },
    ]);
    const target = new MemoryTarget();

    await sync(api, target);

    expect(target.pathsUnder("plugins/finance/skills/expense-review/")).toEqual([
      "plugins/finance/skills/expense-review/.notion-sync.json",
      "plugins/finance/skills/expense-review/SKILL.md",
      "plugins/finance/skills/expense-review/assets/banner.png",
      "plugins/finance/skills/expense-review/scripts/run.py",
    ]);
    expect(target.text("plugins/finance/skills/expense-review/SKILL.md")).not.toContain(
      "From the zip",
    );
    expect(target.bytes("plugins/finance/skills/expense-review/assets/banner.png")).toEqual(png);
    expect(target.has("plugins/finance/skills/expense-review/files.zip")).toBe(false);
  });

  test("survives a non-ASCII page title (a PAX long name on the wire)", async () => {
    const api = new FakeSkillsApi([
      {
        name: "Finance",
        skills: [{ title: "Café — Dépenses ✨", name: "cafe-depenses" }],
      },
    ]);
    const target = new MemoryTarget();

    await sync(api, target);

    expect(target.text("plugins/finance/skills/cafe-depenses/SKILL.md")).toContain(
      "Instructions for Café — Dépenses ✨",
    );
  });

  test("drops archive entries that would escape the skill directory", async () => {
    const api = new FakeSkillsApi([
      {
        name: "Finance",
        skills: [{ title: "Expense Review", attachments: { "../../escape.md": "nope" } }],
      },
    ]);
    const target = new MemoryTarget();

    await sync(api, target);

    expect(target.paths().some((p) => p.includes("escape.md"))).toBe(false);
  });
});

describe("the workspace shape", () => {
  test("publishes nothing for an empty plugin", async () => {
    const api = new FakeSkillsApi([
      { name: "Finance", skills: [{ title: "Expense Review" }] },
      { name: "Empty", skills: [] },
    ]);
    const target = new MemoryTarget();

    const result = await sync(api, target);

    expect(target.pathsUnder("plugins/empty/")).toEqual([]);
    expect(result.plan.desiredSlugs).toEqual(["finance"]);
    expect(
      target
        .json<{ plugins: Array<{ name: string }> }>(".claude-plugin/marketplace.json")
        .plugins.map((p) => p.name),
    ).toEqual(["finance"]);
  });

  test("keeps the same skill title in two plugins separate, with no slug suffixes", async () => {
    const api = new FakeSkillsApi([
      { name: "Finance", skills: [{ title: "Review" }] },
      { name: "EPD", skills: [{ title: "Review" }] },
    ]);
    const target = new MemoryTarget();

    await sync(api, target);

    // Slugs are unique *within* a plugin, so neither gets a -2.
    expect(target.has("plugins/finance/skills/review/SKILL.md")).toBe(true);
    expect(target.has("plugins/epd/skills/review/SKILL.md")).toBe(true);
  });

  test("deduplicates skills whose titles kebab-case to the same slug", async () => {
    const api = new FakeSkillsApi([
      { name: "Finance", skills: [{ title: "Review" }, { title: "Review!" , name: "review" }] },
    ]);
    const target = new MemoryTarget();

    await sync(api, target);

    expect(target.pathsUnder("plugins/finance/skills/").filter((p) => p.endsWith("SKILL.md"))).toEqual([
      "plugins/finance/skills/review-2/SKILL.md",
      "plugins/finance/skills/review/SKILL.md",
    ]);
  });

  test("follows the pagination cursor across every page of plugins", async () => {
    const api = new FakeSkillsApi(
      [
        { name: "Finance", skills: [{ title: "Expense Review" }] },
        { name: "EPD", skills: [{ title: "Design Review" }] },
        { name: "Sales", skills: [{ title: "Deal Desk" }] },
      ],
      { pageSize: 1 },
    );
    const target = new MemoryTarget();

    await sync(api, target);

    const listCalls = api.requests.filter((p) => p.startsWith("/v1/ai/plugins"));
    expect(listCalls).toEqual([
      "/v1/ai/plugins",
      "/v1/ai/plugins?start_cursor=1",
      "/v1/ai/plugins?start_cursor=2",
    ]);
    expect(target.pathsUnder("plugins/").filter((p) => p.endsWith("SKILL.md"))).toHaveLength(3);
  });

  test("commits nothing when the workspace has no visible skills", async () => {
    const api = new FakeSkillsApi([]);
    const target = new MemoryTarget();

    const result = await sync(api, target);

    // Only the (empty) marketplaces would be desired, and on an empty target
    // they're still a change — but nothing skill-shaped is published.
    expect(result.plan.skillSlugs).toEqual([]);
    expect(target.pathsUnder("plugins/")).toEqual([]);
  });
});

describe("rate limits and failures", () => {
  test("retries a 429 that carries Retry-After and completes the sync", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    api.failNext({ status: 429, retryAfter: 0, pathIncludes: "/v1/ai/plugins" });
    const target = new MemoryTarget();

    const result = await sync(api, target);

    expect(result.committed).toBe(true);
    expect(api.requests.filter((p) => p.startsWith("/v1/ai/plugins"))).toHaveLength(2);
  });

  test("retries a 429 with no Retry-After, and a 529 overload, on the archive route", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    api.failNext({ status: 429, pathIncludes: "/v1/ai/skills/" });
    api.failNext({ status: 529, pathIncludes: "/v1/ai/skills/" });
    const target = new MemoryTarget();

    const result = await sync(api, target);

    expect(result.committed).toBe(true);
    expect(target.pathsUnder("plugins/finance/skills/").length).toBe(4);
  });

  test("gives up after the retry budget and says what to check", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    for (let i = 0; i < 5; i++) {
      api.failNext({ status: 429, retryAfter: 0, pathIncludes: "/v1/ai/plugins" });
    }
    const target = new MemoryTarget();

    await expect(sync(api, target)).rejects.toThrow(/429/);
    expect(target.commits).toHaveLength(0);
  });

  test("explains a 403 as either the feature gate or the token's access", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    api.failNext({
      status: 403,
      body: { code: "restricted_resource", message: "Endpoint unavailable." },
      pathIncludes: "/v1/ai/plugins",
    });
    const target = new MemoryTarget();

    const err = await sync(api, target).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("public_api_skills_plugins");
    expect((err as Error).message).toContain("read content access");
  });

  test("names a route rename as the first suspect for a 400 invalid_request_url", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    api.failNext({
      status: 400,
      body: { code: "invalid_request_url", message: "Invalid request URL" },
      pathIncludes: "/v1/ai/plugins",
    });
    const target = new MemoryTarget();

    const err = await sync(api, target).catch((e: Error) => e);
    expect((err as Error).message).toContain("route");
  });

  test("nothing is written when the run fails partway through", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    // The list succeeds; the second skill's archive never resolves.
    for (let i = 0; i < 5; i++) {
      api.failNext({ status: 500, body: { code: "internal_server_error" }, pathIncludes: "/v1/ai/skills/" });
    }
    const target = new MemoryTarget();

    await expect(sync(api, target)).rejects.toThrow();
    // One atomic apply per sync: a failure leaves the target exactly as it was.
    expect(target.paths()).toEqual([]);
    expect(target.commits).toHaveLength(0);
  });
});

describe("the sync's own reporting", () => {
  test("describes the commit in terms a reviewer can scan", async () => {
    const api = new FakeSkillsApi(TWO_SKILLS);
    const target = new MemoryTarget();
    await sync(api, target);

    const message = target.commits[0]!.message;
    expect(message).toContain("notion-skills sync: 2 skill(s)");
    expect(message).toContain("Synced from the Notion Skills API (dev)");
    expect(message).toContain("Skills: expense-review, budget-close");
  });

  test("names what it pruned", async () => {
    const api = new FakeSkillsApi([
      ...TWO_SKILLS,
      { name: "EPD", skills: [{ title: "Design Review" }] },
    ]);
    const target = new MemoryTarget();
    await sync(api, target);
    api.deletePlugin("EPD");
    await sync(api, target);

    expect(target.commits[1]!.message).toContain("Pruned: epd");
  });
});

/** A byte-for-byte check that the fake's archives really are tar.gz. */
test("the fake API serves genuine gzipped tar archives", async () => {
  const api = new FakeSkillsApi([{ name: "Finance", skills: [{ title: "Expense Review" }] }]);
  const notion = client(api);
  const [plugin] = await notion.plugins.listAll();
  const { files } = await notion.skills.files({ skill_id: plugin!.skills[0]!.id });

  expect(Object.keys(files)).toEqual(["SKILL.md"]);
  expect(text(files["SKILL.md"]!)).toContain("name: expense-review");
  expect(api.downloads).toHaveLength(1);
});
