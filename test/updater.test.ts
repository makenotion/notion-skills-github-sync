import { describe, expect, test } from "bun:test";
import { notionMcpUrl, notionMcpServerName, buildUpdaterPlugin } from "../src/updater.ts";
import { buildSyncPlan, type PluginInput } from "../src/plan.ts";
import { gitBlobSha } from "../src/diff.ts";
import type { Marketplace } from "../src/convert.ts";

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
    skillsDataSourceId: "ds-123",
    changeRequestsDataSourceId: "cr-456",
  });

  test("emits plugin.json with the env-matched Notion MCP and a skill, no marker", () => {
    const paths = Object.keys(inj.files);
    // One plugin.json per client, all identical content.
    expect(paths).toContain("plugins/notion-skill-updater/.claude-plugin/plugin.json");
    expect(paths).toContain("plugins/notion-skill-updater/.cursor-plugin/plugin.json");
    expect(paths).toContain("plugins/notion-skill-updater/.codex-plugin/plugin.json");
    expect(paths).toContain("plugins/notion-skill-updater/skills/notion-skill-updater/SKILL.md");
    // No Notion back-reference marker (it isn't sourced from Notion).
    expect(paths.some((p) => p.endsWith(".notion-sync.json"))).toBe(false);

    const pj = JSON.parse(inj.files["plugins/notion-skill-updater/.claude-plugin/plugin.json"]!);
    const cursorPj = inj.files["plugins/notion-skill-updater/.cursor-plugin/plugin.json"]!;
    const codexPj = inj.files["plugins/notion-skill-updater/.codex-plugin/plugin.json"]!;
    expect(cursorPj).toBe(inj.files["plugins/notion-skill-updater/.claude-plugin/plugin.json"]!);
    expect(codexPj).toBe(inj.files["plugins/notion-skill-updater/.claude-plugin/plugin.json"]!);
    // Dev connector is keyed "notion-dev" so it's distinguishable in the client.
    expect(pj.mcpServers["notion-dev"]).toEqual({ type: "http", url: "https://mcp-dev.notion.com/mcp" });
    expect(pj.mcpServers.notion).toBeUndefined();

    const skill = inj.files["plugins/notion-skill-updater/skills/notion-skill-updater/SKILL.md"]!;
    expect(skill.startsWith("---\ndescription:")).toBe(true);
    expect(skill).toContain("ds-123"); // data source id for creating new skills
    expect(skill).toContain("dev"); // env mentioned
    // change requests wired up -> propose-a-change section + its data source id
    expect(skill).toContain("cr-456");
    expect(skill).toContain("Propose a change for review");
  });

  test("omits the propose-a-change section when no change requests data source", () => {
    const noCr = buildUpdaterPlugin({
      pluginsDir: "plugins",
      slug: "notion-skill-updater",
      env: "dev",
      skillsDataSourceId: "ds-123",
    });
    const skill = noCr.files["plugins/notion-skill-updater/skills/notion-skill-updater/SKILL.md"]!;
    expect(skill).not.toContain("Propose a change for review");
    expect(skill).toContain("then edit the skill directly.");
  });

  test("prod env bakes the prod MCP url", () => {
    const p = buildUpdaterPlugin({ pluginsDir: "plugins", slug: "u", env: "prod", skillsDataSourceId: "x" });
    const pj = JSON.parse(p.files["plugins/u/.claude-plugin/plugin.json"]!);
    expect(pj.mcpServers.notion.url).toBe("https://mcp.notion.com/mcp");
    expect(pj.mcpServers["notion-prod"]).toBeUndefined();
  });
});

describe("buildSyncPlan with injected updater", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const mkPlugin = (name: string): PluginInput => ({
    name,
    description: `d ${name}`,
    skillDirs: [{ name, files: { "SKILL.md": enc(`# ${name}\n`) } }],
  });
  const inj = buildUpdaterPlugin({ pluginsDir: "plugins", slug: "notion-skill-updater", env: "dev", skillsDataSourceId: "ds" });
  const emptyMarketplace: Marketplace = { name: "m", plugins: [] };

  test("injected plugin is added to files + marketplace and never pruned", () => {
    // Repo already has a plugin 'old' that the API no longer serves.
    const existing = new Map<string, string>([
      ["plugins/old/skills/old/SKILL.md", gitBlobSha("x")],
    ]);
    const plan = buildSyncPlan({
      plugins: [mkPlugin("skills")],
      existing,
      existingMarketplaces: { claude: emptyMarketplace },
      pluginsDir: "plugins",
      injected: [inj],
    });

    expect(plan.desiredSlugs).toEqual(["skills"]);
    expect(plan.injectedSlugs).toEqual(["notion-skill-updater"]);
    expect(plan.prunedSlugs).toEqual(["old"]); // updater is not pruned
    // updater files present for every client
    for (const dir of [".claude-plugin", ".cursor-plugin", ".codex-plugin"]) {
      expect(Object.keys(plan.desiredFiles)).toContain(
        `plugins/notion-skill-updater/${dir}/plugin.json`,
      );
    }
    // every client's marketplace contains the default skills plugin + the updater
    for (const id of ["claude", "cursor", "codex"] as const) {
      const names = plan.marketplaces[id].plugins.map((p) => p.name);
      expect(names).toContain("skills");
      expect(names).toContain("notion-skill-updater");
    }
  });

  test("idempotent: re-planning over applied output makes no changes", () => {
    const first = buildSyncPlan({
      plugins: [mkPlugin("skills")],
      existing: new Map(),
      existingMarketplaces: { claude: emptyMarketplace },
      pluginsDir: "plugins",
      injected: [inj],
    });
    const after = new Map<string, string>();
    for (const [p, c] of Object.entries(first.desiredFiles)) after.set(p, gitBlobSha(c));

    const second = buildSyncPlan({
      plugins: [mkPlugin("skills")],
      existing: after,
      existingMarketplaces: first.marketplaces,
      pluginsDir: "plugins",
      injected: [inj],
    });
    expect(second.changes.create).toEqual([]);
    expect(second.changes.delete).toEqual([]);
  });
});
