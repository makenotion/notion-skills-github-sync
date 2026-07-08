import { describe, expect, test } from "bun:test";
import { buildSyncPlan, detectManagedSlugs, MARKETPLACE_PATH } from "../src/plan.ts";
import { gitBlobSha } from "../src/diff.ts";
import type { Marketplace, NotionSourceMeta, SkillInput } from "../src/convert.ts";

const META: NotionSourceMeta = { env: "dev", databaseId: "db", skillsDataSourceId: "ds" };

const mkSkill = (slug: string, body = "body", pluginSlug = "skills"): SkillInput => ({
  pageId: `page-${slug}`,
  name: slug,
  slug,
  description: `desc ${slug}`,
  body,
  createdBy: "Tester",
  pluginSlug,
});

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

  // A repo that currently has an unmanaged hello-world and a managed "old" skill.
  const existing = new Map<string, string>([
    ["plugins/hello-world/.claude-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/hello-world/skills/hello-world/SKILL.md", gitBlobSha("hi")],
    ["plugins/old/.claude-plugin/plugin.json", gitBlobSha("{}")],
    ["plugins/old/skills/old/SKILL.md", gitBlobSha("old body")],
    ["plugins/old/skills/old/.notion-sync.json", gitBlobSha("{}")],
    [MARKETPLACE_PATH, gitBlobSha(JSON.stringify(existingMarketplace, null, 2) + "\n")],
  ]);

  test("adds new skill, prunes removed managed skill, preserves hello-world", () => {
    const plan = buildSyncPlan({
      skills: [mkSkill("message-review")], // defaults to pluginSlug: "skills"
      existing,
      existingMarketplace,
      pluginsDir: "plugins",
      meta: META,
    });

    expect(plan.desiredSlugs).toEqual(["skills"]);
    expect(plan.prunedSlugs).toEqual(["old"]);

    // new skill files present in default "skills" plugin
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/skills/message-review/SKILL.md",
    );
    // pruned plugin's files are all scheduled for deletion
    expect(plan.deletePaths.sort()).toEqual([
      "plugins/old/.claude-plugin/plugin.json",
      "plugins/old/skills/old/.notion-sync.json",
      "plugins/old/skills/old/SKILL.md",
    ]);

    // marketplace preserves hello-world, drops old, adds skills
    const names = plan.marketplace.plugins.map((p) => p.name);
    expect(names).toContain("hello-world");
    expect(names).toContain("skills");
    expect(names).not.toContain("old");
  });

  test("idempotent: re-planning against its own output yields no changes", () => {
    const skills = [mkSkill("message-review")]; // defaults to pluginSlug: "skills"
    const first = buildSyncPlan({
      skills,
      existing,
      existingMarketplace,
      pluginsDir: "plugins",
      meta: META,
    });

    // Simulate the repo AFTER applying `first`: hello-world stays, old removed,
    // new files written to "skills" plugin, marketplace updated.
    const after = new Map<string, string>();
    after.set("plugins/hello-world/.claude-plugin/plugin.json", gitBlobSha("{}"));
    after.set("plugins/hello-world/skills/hello-world/SKILL.md", gitBlobSha("hi"));
    for (const [path, content] of Object.entries(first.desiredFiles)) {
      after.set(path, gitBlobSha(content));
    }

    const second = buildSyncPlan({
      skills,
      existing: after,
      existingMarketplace: first.marketplace,
      pluginsDir: "plugins",
      meta: META,
    });

    expect(second.changes.create).toEqual([]);
    expect(second.changes.delete).toEqual([]);
    expect(second.prunedSlugs).toEqual([]);
  });

  test("groups multiple skills into one plugin when they share pluginSlug", () => {
    // Two skills that both belong to the "writing-tools" plugin.
    const skills = [
      mkSkill("email-draft", "body1", "writing-tools"),
      mkSkill("meeting-notes", "body2", "writing-tools"),
    ];
    const plan = buildSyncPlan({
      skills,
      existing: new Map(),
      existingMarketplace: { plugins: [] },
      pluginsDir: "plugins",
      meta: META,
    });

    // Both skills should be in the same plugin directory.
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/writing-tools/skills/email-draft/SKILL.md",
    );
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/writing-tools/skills/meeting-notes/SKILL.md",
    );
    // Both skills share the same plugin.json.
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/writing-tools/.claude-plugin/plugin.json",
    );

    // Only one marketplace entry for the plugin.
    expect(plan.desiredSlugs).toEqual(["writing-tools"]);
    const pluginNames = plan.marketplace.plugins.map((p) => p.name);
    expect(pluginNames.filter((n) => n === "writing-tools")).toHaveLength(1);
  });

  test("skills without pluginSlug override go into default 'skills' plugin", () => {
    const skills = [
      mkSkill("standalone-skill"), // pluginSlug defaults to "skills"
      mkSkill("another-skill"),    // also defaults to "skills"
      mkSkill("grouped-skill", "body", "shared-plugin"),
    ];
    const plan = buildSyncPlan({
      skills,
      existing: new Map(),
      existingMarketplace: { plugins: [] },
      pluginsDir: "plugins",
      meta: META,
    });

    // Both standalone skills go into the default "skills" plugin.
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/skills/standalone-skill/SKILL.md",
    );
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/skills/another-skill/SKILL.md",
    );
    // grouped-skill goes into shared-plugin.
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/shared-plugin/skills/grouped-skill/SKILL.md",
    );

    expect(plan.desiredSlugs.sort()).toEqual(["shared-plugin", "skills"]);
  });

  test("publishes one skill into every plugin it is tagged with (multi-select)", () => {
    // A single skill (same slug) tagged with two plugins expands to two
    // SkillInputs sharing the slug but living in different plugin dirs.
    const skills = [
      mkSkill("email-draft", "body", "writing-tools"),
      mkSkill("email-draft", "body", "research"),
    ];
    const plan = buildSyncPlan({
      skills,
      existing: new Map(),
      existingMarketplace: { plugins: [] },
      pluginsDir: "plugins",
      meta: META,
    });

    // The skill appears under both plugin directories.
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/writing-tools/skills/email-draft/SKILL.md",
    );
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/research/skills/email-draft/SKILL.md",
    );

    // Both plugins are desired and each gets a marketplace entry.
    expect(plan.desiredSlugs.sort()).toEqual(["research", "writing-tools"]);
    const names = plan.marketplace.plugins.map((p) => p.name).sort();
    expect(names).toEqual(["research", "writing-tools"]);
  });

  test("prunes a skill's old dir when it moves to another plugin that stays live", () => {
    // First sync: both skills live in the default "skills" plugin.
    const before = buildSyncPlan({
      skills: [mkSkill("mover"), mkSkill("stayer")],
      existing: new Map(),
      existingMarketplace: { plugins: [] },
      pluginsDir: "plugins",
      meta: META,
    });
    const repo = new Map<string, string>();
    for (const [path, content] of Object.entries(before.desiredFiles)) {
      repo.set(path, gitBlobSha(content));
    }

    // Second sync: "mover" moves to the "finance" plugin; "skills" stays live.
    const plan = buildSyncPlan({
      skills: [mkSkill("mover", "body", "finance"), mkSkill("stayer")],
      existing: repo,
      existingMarketplace: before.marketplace,
      pluginsDir: "plugins",
      meta: META,
    });

    // The stale copy under the still-live "skills" plugin is deleted...
    expect(plan.deletePaths.sort()).toEqual([
      "plugins/skills/skills/mover/.notion-sync.json",
      "plugins/skills/skills/mover/SKILL.md",
    ]);
    // ...but the "skills" plugin itself is not pruned (stayer remains).
    expect(plan.prunedSlugs).toEqual([]);
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/finance/skills/mover/SKILL.md",
    );
    expect(Object.keys(plan.desiredFiles)).toContain(
      "plugins/skills/skills/stayer/SKILL.md",
    );
  });
});
