import { describe, expect, test } from "bun:test";
import {
  buildSyncPlan,
  CLAUDE_MARKETPLACE_PATH,
  CODEX_MARKETPLACE_PATH,
  CURSOR_MARKETPLACE_PATH,
  MARKETPLACE_PATH,
  type PluginInput,
} from "../src/plan.ts";
import { gitBlobSha } from "../src/diff.ts";
import type { Marketplace } from "../src/convert.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// A plugin with one skill dir per given skill name; each dir ships a SKILL.md.
const mkPlugin = (
  name: string,
  skillNames: string[] = [name],
  description = `desc ${name}`,
): PluginInput => ({
  name,
  description,
  skillDirs: skillNames.map((s) => ({
    name: s,
    files: { "SKILL.md": enc(`# ${s}\n`) },
  })),
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

  // A repo with an unmanaged hello-world (outside pluginsDir would be preserved,
  // but here it lives under pluginsDir so the API is authoritative) and an "old"
  // plugin no longer served by the API.
  const existing = new Map<string, string>([
    ["plugins/old/.claude-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/old/.cursor-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/old/.codex-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/old/skills/old/SKILL.md", gitBlobSha("old body")],
    [MARKETPLACE_PATH, gitBlobSha(JSON.stringify(existingMarketplace, null, 2) + "\n")],
  ]);

  test("adds new plugin, prunes plugin the API no longer serves", () => {
    const plan = buildSyncPlan({
      plugins: [mkPlugin("skills", ["message-review"])],
      existing,
      existingMarketplaces: { claude: existingMarketplace },
      pluginsDir: "plugins",
    });

    expect(plan.desiredSlugs).toEqual(["skills"]);
    expect(plan.prunedSlugs).toEqual(["old"]);

    // new skill dir contents present in the "skills" plugin
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/skills/message-review/SKILL.md",
    );
    // pruned plugin's files are all scheduled for deletion
    expect(plan.deletePaths.sort()).toEqual([
      "plugins/old/.claude-plugin/plugin.json",
      "plugins/old/.codex-plugin/plugin.json",
      "plugins/old/.cursor-plugin/plugin.json",
      "plugins/old/skills/old/SKILL.md",
    ]);

    // marketplace drops old, adds skills
    const names = plan.marketplace.plugins.map((p) => p.name);
    expect(names).toContain("skills");
    expect(names).not.toContain("old");
  });

  test("emits a marketplace + per-plugin manifest for every client", () => {
    const plan = buildSyncPlan({
      plugins: [mkPlugin("skills", ["message-review"], "the skills plugin")],
      existing: new Map(),
      existingMarketplaces: {},
      pluginsDir: "plugins",
    });

    // Three marketplace files, one per client.
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
      description: "the skills plugin",
      author: { name: "Notion Skills" },
    });

    // Claude + Cursor entries share the simple shape; Codex uses its structured one.
    const claudeEntry = plan.marketplaces.claude.plugins.find((p) => p.name === "skills");
    const cursorEntry = plan.marketplaces.cursor.plugins.find((p) => p.name === "skills");
    const codexEntry = plan.marketplaces.codex.plugins.find((p) => p.name === "skills");
    expect(claudeEntry).toEqual({
      name: "skills",
      source: "./plugins/skills",
      description: "the skills plugin",
    });
    expect(cursorEntry).toEqual(claudeEntry);
    expect(codexEntry).toEqual({
      name: "skills",
      source: { source: "local", path: "./plugins/skills" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
  });

  test("preserves each client's marketplace shape and entries pointing outside pluginsDir", () => {
    const handAuthored = {
      name: "external",
      source: "./vendor/external",
      description: "hand-authored, outside pluginsDir",
    };
    const plan = buildSyncPlan({
      plugins: [mkPlugin("skills", ["message-review"])],
      existing: new Map(),
      existingMarketplaces: {
        claude: { name: "s", owner: { name: "T" }, plugins: [handAuthored] },
        cursor: {
          name: "s",
          owner: { name: "T" },
          metadata: { description: "d" },
          plugins: [handAuthored],
        },
        codex: {
          name: "s",
          interface: { displayName: "S" },
          plugins: [
            {
              name: "external",
              source: { source: "local", path: "./vendor/external" },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Productivity",
            },
          ],
        },
      },
      pluginsDir: "plugins",
    });

    // Top-level client-specific keys survive the merge.
    expect(plan.marketplaces.cursor.metadata).toEqual({ description: "d" });
    expect(plan.marketplaces.codex.interface).toEqual({ displayName: "S" });
    // Hand-authored external entry (not controlled) preserved in every client.
    for (const id of ["claude", "cursor", "codex"] as const) {
      expect(plan.marketplaces[id].plugins.map((p) => p.name)).toContain("external");
      expect(plan.marketplaces[id].plugins.map((p) => p.name)).toContain("skills");
    }
  });

  test("idempotent: re-planning against its own output yields no changes", () => {
    const plugins = [mkPlugin("skills", ["message-review"])];
    const first = buildSyncPlan({
      plugins,
      existing,
      existingMarketplaces: { claude: existingMarketplace },
      pluginsDir: "plugins",
    });

    // Simulate the repo AFTER applying `first`.
    const after = new Map<string, string>();
    for (const [path, content] of Object.entries(first.desiredFiles)) {
      after.set(path, gitBlobSha(content));
    }

    const second = buildSyncPlan({
      plugins,
      existing: after,
      existingMarketplaces: first.marketplaces,
      pluginsDir: "plugins",
    });

    expect(second.changes.create).toEqual([]);
    expect(second.changes.delete).toEqual([]);
    expect(second.prunedSlugs).toEqual([]);
  });

  test("groups multiple skill directories under one plugin", () => {
    const plan = buildSyncPlan({
      plugins: [mkPlugin("writing-tools", ["email-draft", "meeting-notes"])],
      existing: new Map(),
      existingMarketplaces: {},
      pluginsDir: "plugins",
    });

    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/writing-tools/skills/email-draft/SKILL.md",
    );
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/writing-tools/skills/meeting-notes/SKILL.md",
    );
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/writing-tools/.claude-plugin/plugin.json",
    );

    expect(plan.desiredSlugs).toEqual(["writing-tools"]);
    const pluginNames = plan.marketplace.plugins.map((p) => p.name);
    expect(pluginNames.filter((n) => n === "writing-tools")).toHaveLength(1);
  });

  test("lays down all files from a skill dir, including nested extras", () => {
    const plan = buildSyncPlan({
      plugins: [
        {
          name: "skills",
          description: "d",
          skillDirs: [
            {
              name: "packer",
              files: {
                "SKILL.md": enc("# packer\n"),
                "scripts/run.py": enc("print('hi')"),
                "references/notes.md": enc("# ref"),
              },
            },
          ],
        },
      ],
      existing: new Map(),
      existingMarketplaces: {},
      pluginsDir: "plugins",
    });

    for (const p of [
      "plugins/skills/skills/packer/SKILL.md",
      "plugins/skills/skills/packer/scripts/run.py",
      "plugins/skills/skills/packer/references/notes.md",
    ]) {
      expect(Object.keys(plan.desiredFiles)).toContain(p);
    }
  });

  test("prunes stale files under a plugin the API still serves", () => {
    // First sync: skill ships two extra files.
    const before = buildSyncPlan({
      plugins: [
        {
          name: "skills",
          description: "d",
          skillDirs: [
            {
              name: "packer",
              files: { "scripts/a.py": enc("a"), "scripts/b.py": enc("b") },
            },
          ],
        },
      ],
      existing: new Map(),
      existingMarketplaces: {},
      pluginsDir: "plugins",
    });
    const repo = new Map<string, string>();
    for (const [path, content] of Object.entries(before.desiredFiles)) {
      repo.set(path, gitBlobSha(content));
    }
    expect(repo.has("plugins/skills/skills/packer/scripts/b.py")).toBe(true);

    // Second sync: the archive lost b.py.
    const plan = buildSyncPlan({
      plugins: [
        {
          name: "skills",
          description: "d",
          skillDirs: [{ name: "packer", files: { "scripts/a.py": enc("a") } }],
        },
      ],
      existing: repo,
      existingMarketplaces: before.marketplaces,
      pluginsDir: "plugins",
    });

    expect(plan.deletePaths).toEqual(["plugins/skills/skills/packer/scripts/b.py"]);
    expect(plan.prunedSlugs).toEqual([]);
    expect(Object.keys(plan.desiredFiles)).toContain("plugins/skills/skills/packer/scripts/a.py");
  });
});
