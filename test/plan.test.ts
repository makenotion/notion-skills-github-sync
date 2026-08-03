import { describe, expect, test } from "bun:test";
import {
  buildSyncPlan,
  CLAUDE_MARKETPLACE_PATH,
  CODEX_MARKETPLACE_PATH,
  CURSOR_MARKETPLACE_PATH,
  detectManagedSlugs,
  MARKETPLACE_PATH,
} from "../src/plan.ts";
import { gitBlobSha } from "../src/diff.ts";
import type { Marketplace, NotionSourceMeta, PluginInfo, SkillInput } from "../src/convert.ts";

const META: NotionSourceMeta = { env: "dev", databaseId: "db", skillsDataSourceId: "ds" };

const PLUGIN: PluginInfo = {
  slug: "skills",
  description: "Skills managed by Notion",
  author: "Notion Workspace Skills",
};

const enc = (s: string) => new TextEncoder().encode(s);

// A skill whose archive was downloaded this run.
const mkSkill = (
  slug: string,
  files: Record<string, string | Uint8Array> = { "SKILL.md": `body ${slug}` },
): SkillInput => ({
  directoryId: `dir-${slug}`,
  name: slug,
  slug,
  description: `desc ${slug}`,
  versionId: `v-${slug}`,
  files,
});

// A skill the sync left alone because its version_id already matched.
const retained = (slug: string): SkillInput => {
  const { files, ...rest } = mkSkill(slug);
  void files;
  return rest;
};

describe("detectManagedSlugs", () => {
  test("finds slugs from marker paths only", () => {
    const paths = [
      "plugins/alpha/skills/alpha/.notion-sync.json",
      "plugins/alpha/skills/alpha/SKILL.md",
      "plugins/hello-world/skills/hello-world/SKILL.md", // no marker
      "plugins/beta/skills/beta/.notion-sync.json",
      "marketplace.json",
    ];
    expect([...detectManagedSlugs(paths, "plugins")].sort()).toEqual(["alpha", "beta"]);
  });
});

describe("buildSyncPlan", () => {
  const existingMarketplace: Marketplace = {
    name: "test-skills",
    owner: { name: "Test Team" },
    plugins: [
      { name: "hello-world", source: "./plugins/hello-world", description: "hi" },
      { name: "old", source: "./plugins/old", description: "stale" },
    ],
  };

  // A repo that currently has an unmanaged hello-world and a managed "old"
  // plugin (left over from the pre-API per-skill grouping), each with all three
  // clients' plugin manifests.
  const existing = new Map<string, string>([
    ["plugins/hello-world/.claude-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/hello-world/.cursor-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/hello-world/.codex-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/hello-world/skills/hello-world/SKILL.md", gitBlobSha("hi")],
    ["plugins/old/.claude-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/old/.cursor-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/old/.codex-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/old/skills/old/SKILL.md", gitBlobSha("old body")],
    ["plugins/old/skills/old/.notion-sync.json", gitBlobSha("{}")],
    [MARKETPLACE_PATH, gitBlobSha(JSON.stringify(existingMarketplace, null, 2) + "\n")],
  ]);

  test("adds new skill, prunes removed managed plugin, preserves hello-world", () => {
    const plan = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills: [mkSkill("message-review")] }],
      existing,
      existingMarketplaces: { claude: existingMarketplace },
      pluginsDir: "plugins",
      meta: META,
    });

    expect(plan.desiredSlugs).toEqual(["skills"]);
    expect(plan.skillSlugs).toEqual(["message-review"]);
    expect(plan.prunedSlugs).toEqual(["old"]);

    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/skills/message-review/SKILL.md",
    );
    // pruned plugin's files are all scheduled for deletion (every client's manifest)
    expect(plan.deletePaths.sort()).toEqual([
      "plugins/old/.claude-plugin/plugin.json",
      "plugins/old/.codex-plugin/plugin.json",
      "plugins/old/.cursor-plugin/plugin.json",
      "plugins/old/skills/old/.notion-sync.json",
      "plugins/old/skills/old/SKILL.md",
    ]);

    const names = plan.marketplace.plugins.map((p) => p.name);
    expect(names).toContain("hello-world");
    expect(names).toContain("skills");
    expect(names).not.toContain("old");
  });

  test("emits a marketplace + per-plugin manifest for every client", () => {
    const plan = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills: [mkSkill("message-review")] }],
      existing: new Map(),
      existingMarketplaces: {},
      pluginsDir: "plugins",
      meta: META,
    });

    for (const path of [CLAUDE_MARKETPLACE_PATH, CURSOR_MARKETPLACE_PATH, CODEX_MARKETPLACE_PATH]) {
      expect(Object.keys(plan.desiredFiles)).toContain(path);
    }

    // Three per-plugin manifests, one per client dir, all identical content.
    const claudeJson = plan.desiredFiles["plugins/skills/.claude-plugin/plugin.json"];
    const cursorJson = plan.desiredFiles["plugins/skills/.cursor-plugin/plugin.json"];
    const codexJson = plan.desiredFiles["plugins/skills/.codex-plugin/plugin.json"];
    expect(claudeJson).toBeDefined();
    expect(cursorJson).toBe(claudeJson as string);
    expect(codexJson).toBe(claudeJson as string);
    expect(JSON.parse(claudeJson as string)).toEqual({
      name: "skills",
      version: "1.0.0",
      description: "Skills managed by Notion",
      author: { name: "Notion Workspace Skills" },
    });

    // Claude + Cursor entries share the simple shape; Codex uses its structured one.
    const claudeEntry = plan.marketplaces.claude.plugins.find((p) => p.name === "skills");
    const cursorEntry = plan.marketplaces.cursor.plugins.find((p) => p.name === "skills");
    const codexEntry = plan.marketplaces.codex.plugins.find((p) => p.name === "skills");
    expect(claudeEntry).toEqual({
      name: "skills",
      source: "./plugins/skills",
      description: "Skills managed by Notion",
    });
    expect(cursorEntry).toEqual(claudeEntry);
    expect(codexEntry).toEqual({
      name: "skills",
      source: { source: "local", path: "./plugins/skills" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
  });

  test("preserves each client's existing marketplace shape and hand-authored entries", () => {
    const plan = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills: [mkSkill("message-review")] }],
      existing: new Map(),
      existingMarketplaces: {
        claude: {
          name: "s",
          owner: { name: "T" },
          plugins: [{ name: "hello-world", source: "./plugins/hello-world", description: "hi" }],
        },
        cursor: {
          name: "s",
          owner: { name: "T" },
          metadata: { description: "d" },
          plugins: [{ name: "hello-world", source: "./plugins/hello-world", description: "hi" }],
        },
        codex: {
          name: "s",
          interface: { displayName: "S" },
          plugins: [
            {
              name: "hello-world",
              source: { source: "local", path: "./plugins/hello-world" },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Productivity",
            },
          ],
        },
      },
      pluginsDir: "plugins",
      meta: META,
    });

    expect(plan.marketplaces.cursor.metadata).toEqual({ description: "d" });
    expect(plan.marketplaces.codex.interface).toEqual({ displayName: "S" });
    for (const id of ["claude", "cursor", "codex"] as const) {
      expect(plan.marketplaces[id].plugins.map((p) => p.name)).toContain("hello-world");
      expect(plan.marketplaces[id].plugins.map((p) => p.name)).toContain("skills");
    }
  });

  test("idempotent: re-planning against its own output yields no changes", () => {
    const skills = [mkSkill("message-review")];
    const first = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills }],
      existing,
      existingMarketplaces: { claude: existingMarketplace },
      pluginsDir: "plugins",
      meta: META,
    });

    const after = new Map<string, string>();
    after.set("plugins/hello-world/.claude-plugin/plugin.json", gitBlobSha("{}"));
    after.set("plugins/hello-world/skills/hello-world/SKILL.md", gitBlobSha("hi"));
    for (const [path, content] of Object.entries(first.desiredFiles)) {
      after.set(path, gitBlobSha(content));
    }

    const second = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills }],
      existing: after,
      existingMarketplaces: first.marketplaces,
      pluginsDir: "plugins",
      meta: META,
    });

    expect(second.changes.create).toEqual([]);
    expect(second.changes.delete).toEqual([]);
    expect(second.prunedSlugs).toEqual([]);
  });

  test("all skills land in the one configured plugin directory", () => {
    const plan = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills: [mkSkill("email-draft"), mkSkill("meeting-notes")] }],
      existing: new Map(),
      existingMarketplaces: {},
      pluginsDir: "plugins",
      meta: META,
    });

    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/skills/email-draft/SKILL.md",
    );
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/skills/meeting-notes/SKILL.md",
    );
    // One shared plugin.json, one marketplace entry.
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/.claude-plugin/plugin.json",
    );
    expect(plan.desiredSlugs).toEqual(["skills"]);
    expect(plan.marketplace.plugins.filter((p) => p.name === "skills")).toHaveLength(1);
  });

  test("overlay prune: removes stale extra files under a live skill dir", () => {
    const before = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills: [
        mkSkill("packer", {
          "SKILL.md": "body",
          "scripts/a.py": enc("a"),
          "scripts/b.py": enc("b"),
        }),
      ] }],
      existing: new Map(),
      existingMarketplaces: {},
      pluginsDir: "plugins",
      meta: META,
    });
    const repo = new Map<string, string>();
    for (const [path, content] of Object.entries(before.desiredFiles)) {
      repo.set(path, gitBlobSha(content));
    }
    expect(repo.has("plugins/skills/skills/packer/scripts/b.py")).toBe(true);

    // Second sync: the skill lost b.py.
    const plan = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills: [mkSkill("packer", { "SKILL.md": "body", "scripts/a.py": enc("a") })] }],
      existing: repo,
      existingMarketplaces: before.marketplaces,
      pluginsDir: "plugins",
      meta: META,
    });

    expect(plan.deletePaths).toEqual(["plugins/skills/skills/packer/scripts/b.py"]);
    expect(plan.prunedSlugs).toEqual([]);
    expect(Object.keys(plan.desiredFiles)).toContain("plugins/skills/skills/packer/scripts/a.py");
  });

  test("prunes a skill dir whose skill disappeared from Notion", () => {
    const before = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills: [mkSkill("gone"), mkSkill("stayer")] }],
      existing: new Map(),
      existingMarketplaces: {},
      pluginsDir: "plugins",
      meta: META,
    });
    const repo = new Map<string, string>();
    for (const [path, content] of Object.entries(before.desiredFiles)) {
      repo.set(path, gitBlobSha(content));
    }

    const plan = buildSyncPlan({
      plugins: [{ plugin: PLUGIN, skills: [mkSkill("stayer")] }],
      existing: repo,
      existingMarketplaces: before.marketplaces,
      pluginsDir: "plugins",
      meta: META,
    });

    expect(plan.deletePaths.sort()).toEqual([
      "plugins/skills/skills/gone/.notion-sync.json",
      "plugins/skills/skills/gone/SKILL.md",
    ]);
    expect(plan.prunedSlugs).toEqual([]);
    expect(Object.keys(plan.desiredFiles)).toContain("plugins/skills/skills/stayer/SKILL.md");
  });

  // The version_id fast path: a skill whose archive we never downloaded must be
  // left completely alone — not rewritten, and above all not pruned.
  describe("retained (unchanged) skills", () => {
    const seeded = () => {
      const first = buildSyncPlan({
        plugins: [{ plugin: PLUGIN, skills: [mkSkill("alpha"), mkSkill("beta")] }],
        existing: new Map(),
        existingMarketplaces: {},
        pluginsDir: "plugins",
        meta: META,
      });
      const repo = new Map<string, string>();
      for (const [path, content] of Object.entries(first.desiredFiles)) {
        repo.set(path, gitBlobSha(content));
      }
      return { first, repo };
    };

    test("a fully retained run is a no-op", () => {
      const { first, repo } = seeded();
      const plan = buildSyncPlan({
        plugins: [{ plugin: PLUGIN, skills: [retained("alpha"), retained("beta")] }],
        existing: repo,
        existingMarketplaces: first.marketplaces,
        pluginsDir: "plugins",
        meta: META,
      });

      expect(plan.retainedSkills.sort()).toEqual(["alpha", "beta"]);
      expect(plan.changes.create).toEqual([]);
      expect(plan.changes.delete).toEqual([]);
      expect(plan.prunedSlugs).toEqual([]);
    });

    test("retaining one skill while another changes touches only the changed one", () => {
      const { first, repo } = seeded();
      const plan = buildSyncPlan({
        plugins: [{ plugin: PLUGIN, skills: [retained("alpha"), mkSkill("beta", { "SKILL.md": "new beta body" })] }],
        existing: repo,
        existingMarketplaces: first.marketplaces,
        pluginsDir: "plugins",
        meta: META,
      });

      expect(plan.retainedSkills).toEqual(["alpha"]);
      expect(plan.changes.delete).toEqual([]);
      expect(plan.changes.create.map((c) => c.path)).toEqual([
        "plugins/skills/skills/beta/SKILL.md",
      ]);
      // alpha's files were never rendered, so they can't be in the desired set...
      expect(Object.keys(plan.desiredFiles)).not.toContain(
        "plugins/skills/skills/alpha/SKILL.md",
      );
      // ...and must not be pruned for it.
      expect(plan.deletePaths).toEqual([]);
    });

    test("the plugin survives when every one of its skills is retained", () => {
      const { first, repo } = seeded();
      const plan = buildSyncPlan({
        plugins: [{ plugin: PLUGIN, skills: [retained("alpha"), retained("beta")] }],
        existing: repo,
        existingMarketplaces: first.marketplaces,
        pluginsDir: "plugins",
        meta: META,
      });

      expect(plan.desiredSlugs).toEqual(["skills"]);
      expect(plan.marketplace.plugins.map((p) => p.name)).toContain("skills");
    });
  });

  // The API reports one plugin per skills grouping in the workspace, so a run
  // publishes several plugin directories side by side.
  describe("multiple plugins", () => {
    const finance: PluginInfo = { slug: "finance", description: "Finance", author: "Finance" };
    const epd: PluginInfo = { slug: "epd", description: "EPD", author: "EPD" };

    test("each plugin gets its own directory, manifests, and marketplace entry", () => {
      const plan = buildSyncPlan({
        plugins: [
          { plugin: finance, skills: [mkSkill("opex-variance")] },
          { plugin: epd, skills: [mkSkill("message-review")] },
        ],
        existing: new Map(),
        existingMarketplaces: {},
        pluginsDir: "plugins",
        meta: META,
      });

      expect(plan.desiredSlugs).toEqual(["finance", "epd"]);
      expect(plan.skillSlugs).toEqual(["opex-variance", "message-review"]);
      const paths = Object.keys(plan.desiredFiles);
      expect(paths).toContain("plugins/finance/skills/opex-variance/SKILL.md");
      expect(paths).toContain("plugins/epd/skills/message-review/SKILL.md");
      expect(paths).toContain("plugins/finance/.claude-plugin/plugin.json");
      expect(paths).toContain("plugins/epd/.codex-plugin/plugin.json");
      for (const id of ["claude", "cursor", "codex"] as const) {
        const names = plan.marketplaces[id].plugins.map((p) => p.name);
        expect(names).toContain("finance");
        expect(names).toContain("epd");
      }
    });

    // Two plugins can each hold a skill with the same title; they live in
    // separate directories, so neither needs a uniquifying suffix.
    test("the same skill slug in two plugins stays put in both", () => {
      const plan = buildSyncPlan({
        plugins: [
          { plugin: finance, skills: [mkSkill("weekly-report")] },
          { plugin: epd, skills: [mkSkill("weekly-report")] },
        ],
        existing: new Map(),
        existingMarketplaces: {},
        pluginsDir: "plugins",
        meta: META,
      });

      const paths = Object.keys(plan.desiredFiles);
      expect(paths).toContain("plugins/finance/skills/weekly-report/SKILL.md");
      expect(paths).toContain("plugins/epd/skills/weekly-report/SKILL.md");
    });

    test("a plugin with no skills is neither published nor listed", () => {
      const plan = buildSyncPlan({
        plugins: [
          { plugin: finance, skills: [mkSkill("opex-variance")] },
          { plugin: epd, skills: [] },
        ],
        existing: new Map(),
        existingMarketplaces: {},
        pluginsDir: "plugins",
        meta: META,
      });

      expect(plan.desiredSlugs).toEqual(["finance"]);
      expect(Object.keys(plan.desiredFiles).some((p) => p.startsWith("plugins/epd/"))).toBe(false);
      expect(plan.marketplace.plugins.map((p) => p.name)).not.toContain("epd");
    });

    // Emptying one plugin must not disturb the others: only its own subtree is
    // pruned, and it drops out of every client's marketplace.
    test("a plugin that loses all its skills is pruned, the rest survive", () => {
      const first = buildSyncPlan({
        plugins: [
          { plugin: finance, skills: [mkSkill("opex-variance")] },
          { plugin: epd, skills: [mkSkill("message-review")] },
        ],
        existing: new Map(),
        existingMarketplaces: {},
        pluginsDir: "plugins",
        meta: META,
      });
      const repo = new Map(
        Object.entries(first.desiredFiles).map(([p, c]) => [p, gitBlobSha(c)]),
      );

      const second = buildSyncPlan({
        plugins: [{ plugin: finance, skills: [retained("opex-variance")] }],
        existing: repo,
        existingMarketplaces: first.marketplaces,
        pluginsDir: "plugins",
        meta: META,
      });

      expect(second.prunedSlugs).toEqual(["epd"]);
      expect(second.deletePaths.every((p) => p.startsWith("plugins/epd/"))).toBe(true);
      expect(second.deletePaths).toContain("plugins/epd/skills/message-review/SKILL.md");
      for (const id of ["claude", "cursor", "codex"] as const) {
        const names = second.marketplaces[id].plugins.map((p) => p.name);
        expect(names).toContain("finance");
        expect(names).not.toContain("epd");
      }
    });
  });
});
