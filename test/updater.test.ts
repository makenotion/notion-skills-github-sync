import { describe, expect, test } from "bun:test";
import { notionMcpUrl, notionMcpServerName, buildUpdaterPlugin } from "../src/updater.ts";
import { buildSyncPlan, MARKETPLACE_PATH } from "../src/plan.ts";
import { gitBlobSha } from "../src/diff.ts";
import type { Marketplace, NotionSourceMeta, SkillInput } from "../src/convert.ts";

describe("notionMcpUrl", () => {
  test("env -> endpoint", () => {
    expect(notionMcpUrl("dev")).toBe("https://mcp-dev.notion.com/mcp");
    expect(notionMcpUrl("prod")).toBe("https://mcp.notion.com/mcp");
    expect(notionMcpUrl("stg")).toBe("https://mcp-stg.notion.com/mcp");
  });
});

describe("notionMcpServerName", () => {
  test("env-suffixed except prod", () => {
    expect(notionMcpServerName("dev")).toBe("notion-dev");
    expect(notionMcpServerName("prod")).toBe("notion");
    expect(notionMcpServerName("stg")).toBe("notion-stg");
  });
});

describe("buildUpdaterPlugin", () => {
  const inj = buildUpdaterPlugin({
    pluginsDir: "plugins",
    slug: "notion-skill-updater",
    env: "dev",
    dataSourceId: "ds-123",
  });

  test("emits plugin.json with the env-matched Notion MCP and a skill, no marker", () => {
    const paths = Object.keys(inj.files);
    expect(paths).toContain("plugins/notion-skill-updater/.claude-plugin/plugin.json");
    expect(paths).toContain("plugins/notion-skill-updater/skills/notion-skill-updater/SKILL.md");
    // No Notion back-reference marker (it isn't sourced from Notion).
    expect(paths.some((p) => p.endsWith(".notion-sync.json"))).toBe(false);

    const pj = JSON.parse(inj.files["plugins/notion-skill-updater/.claude-plugin/plugin.json"]!);
    // Dev connector is keyed "notion-dev" so it's distinguishable in the client.
    expect(pj.mcpServers["notion-dev"]).toEqual({ type: "http", url: "https://mcp-dev.notion.com/mcp" });
    expect(pj.mcpServers.notion).toBeUndefined();

    const skill = inj.files["plugins/notion-skill-updater/skills/notion-skill-updater/SKILL.md"]!;
    expect(skill.startsWith("---\ndescription:")).toBe(true);
    expect(skill).toContain("ds-123"); // data source id for creating new skills
    expect(skill).toContain("dev"); // env mentioned
  });

  test("prod env bakes the prod MCP url", () => {
    const p = buildUpdaterPlugin({ pluginsDir: "plugins", slug: "u", env: "prod", dataSourceId: "x" });
    const pj = JSON.parse(p.files["plugins/u/.claude-plugin/plugin.json"]!);
    expect(pj.mcpServers.notion.url).toBe("https://mcp.notion.com/mcp");
    expect(pj.mcpServers["notion-prod"]).toBeUndefined();
  });
});

describe("buildSyncPlan with injected updater", () => {
  const meta: NotionSourceMeta = { env: "dev", databaseId: "db", dataSourceId: "ds" };
  const mkSkill = (slug: string): SkillInput => ({
    pageId: `p-${slug}`,
    name: slug,
    slug,
    description: `d ${slug}`,
    body: "body",
    createdBy: "T",
  });
  const inj = buildUpdaterPlugin({ pluginsDir: "plugins", slug: "notion-skill-updater", env: "dev", dataSourceId: "ds" });
  const emptyMarketplace: Marketplace = { name: "m", plugins: [] };

  test("injected plugin is added to files + marketplace and never pruned", () => {
    // Repo already has a managed Notion skill 'old' that is NOT in this sync.
    const existing = new Map<string, string>([
      ["plugins/old/skills/old/.notion-sync.json", gitBlobSha("{}")],
      ["plugins/old/skills/old/SKILL.md", gitBlobSha("x")],
    ]);
    const plan = buildSyncPlan({
      skills: [mkSkill("alpha")],
      existing,
      existingMarketplace: emptyMarketplace,
      pluginsDir: "plugins",
      meta,
      injected: [inj],
    });

    expect(plan.desiredSlugs).toEqual(["alpha"]);
    expect(plan.injectedSlugs).toEqual(["notion-skill-updater"]);
    expect(plan.prunedSlugs).toEqual(["old"]); // updater is not pruned
    // updater files present
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/notion-skill-updater/.claude-plugin/plugin.json",
    );
    // marketplace contains both the Notion skill and the injected updater
    const names = plan.marketplace.plugins.map((p) => p.name);
    expect(names).toContain("alpha");
    expect(names).toContain("notion-skill-updater");
  });

  test("idempotent: re-planning over applied output makes no changes", () => {
    const first = buildSyncPlan({
      skills: [mkSkill("alpha")],
      existing: new Map(),
      existingMarketplace: emptyMarketplace,
      pluginsDir: "plugins",
      meta,
      injected: [inj],
    });
    const after = new Map<string, string>();
    for (const [p, c] of Object.entries(first.desiredFiles)) after.set(p, gitBlobSha(c));

    const second = buildSyncPlan({
      skills: [mkSkill("alpha")],
      existing: after,
      existingMarketplace: first.marketplace,
      pluginsDir: "plugins",
      meta,
      injected: [inj],
    });
    expect(second.changes.create).toEqual([]);
    expect(second.changes.delete).toEqual([]);
  });
});
