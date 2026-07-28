import { describe, expect, test } from "bun:test";
import {
  buildPluginJson,
  buildPluginManifestFiles,
  buildSkillFiles,
  buildSyncMarker,
  marketplaceEntryInput,
  mergeMarketplace,
  type Marketplace,
  type NotionSourceMeta,
  type PluginInfo,
  type SkillInput,
} from "../src/convert.ts";

const META: NotionSourceMeta = {
  env: "dev",
  databaseId: "db123",
  skillsDataSourceId: "ds456",
};

const PLUGIN: PluginInfo = {
  slug: "skills",
  description: "Skills managed by Notion",
  author: "Notion Workspace Skills",
};

const enc = (s: string) => new TextEncoder().encode(s);

const skill = (over: Partial<SkillInput> = {}): SkillInput => ({
  directoryId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "message-review",
  slug: "message-review",
  description: "Review a message before sending.",
  versionId: "a".repeat(64),
  files: { "SKILL.md": "---\nname: message-review\n---\n\nDo the thing.\n" },
  ...over,
});

describe("buildPluginJson", () => {
  test("renders the plugin's shared identity", () => {
    expect(JSON.parse(buildPluginJson(PLUGIN))).toEqual({
      name: "skills",
      version: "1.0.0",
      description: "Skills managed by Notion",
      author: { name: "Notion Workspace Skills" },
    });
  });
});

describe("buildPluginManifestFiles", () => {
  test("emits one identical plugin.json per supported client", () => {
    const files = buildPluginManifestFiles(PLUGIN, "plugins");
    expect(Object.keys(files).sort()).toEqual([
      "plugins/skills/.claude-plugin/plugin.json",
      "plugins/skills/.codex-plugin/plugin.json",
      "plugins/skills/.cursor-plugin/plugin.json",
    ]);
    const claude = files["plugins/skills/.claude-plugin/plugin.json"];
    expect(files["plugins/skills/.cursor-plugin/plugin.json"]).toBe(claude!);
    expect(files["plugins/skills/.codex-plugin/plugin.json"]).toBe(claude!);
  });
});

describe("buildSyncMarker", () => {
  test("carries the Notion back-reference and the API version id", () => {
    const obj = JSON.parse(buildSyncMarker(skill(), META));
    expect(obj.source).toBe("notion");
    expect(obj.notion.directoryId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(obj.notion.skillsDataSourceId).toBe("ds456");
    expect(obj.notion.versionId).toBe("a".repeat(64));
    expect(obj.notion.url).toBe(
      "https://app.dev.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee",
    );
    expect(obj.skill).toEqual({ slug: "message-review", name: "message-review" });
  });

  test("prod env uses www.notion.so", () => {
    const obj = JSON.parse(buildSyncMarker(skill(), { ...META, env: "prod" }));
    expect(obj.notion.url.startsWith("https://www.notion.so/p/")).toBe(true);
  });

  // The sync compares a freshly built marker against the repo's copy to decide
  // whether it can skip downloading the archive, so byte-stability matters.
  test("is byte-stable for an unchanged skill and moves with version_id", () => {
    expect(buildSyncMarker(skill(), META)).toBe(buildSyncMarker(skill(), META));
    expect(buildSyncMarker(skill({ versionId: "b".repeat(64) }), META)).not.toBe(
      buildSyncMarker(skill(), META),
    );
  });

  test("does not depend on the archive contents, only on identity + version", () => {
    expect(buildSyncMarker(skill({ files: { "SKILL.md": "different" } }), META)).toBe(
      buildSyncMarker(skill(), META),
    );
  });
});

describe("buildSkillFiles", () => {
  test("lays the archive contents into the skill dir and adds the marker", () => {
    const files = buildSkillFiles(
      skill({
        files: {
          "SKILL.md": "---\nname: message-review\n---\n\nDo the thing.\n",
          "scripts/run.py": enc("print('hi')"),
          "references/notes.md": enc("# ref"),
        },
      }),
      PLUGIN.slug,
      "plugins",
      META,
    );

    expect(Object.keys(files).sort()).toEqual([
      "plugins/skills/skills/message-review/.notion-sync.json",
      "plugins/skills/skills/message-review/SKILL.md",
      "plugins/skills/skills/message-review/references/notes.md",
      "plugins/skills/skills/message-review/scripts/run.py",
    ]);
    // SKILL.md comes through from the API archive verbatim.
    expect(files["plugins/skills/skills/message-review/SKILL.md"]).toContain("Do the thing.");
  });

  test("the marker always wins over a same-named archive entry", () => {
    const files = buildSkillFiles(
      skill({ files: { ".notion-sync.json": "not ours" } }),
      PLUGIN.slug,
      "plugins",
      META,
    );
    const marker = files["plugins/skills/skills/message-review/.notion-sync.json"];
    expect(JSON.parse(marker as string).source).toBe("notion");
  });

  // A skill with no `files` is one the sync deliberately left alone: it must
  // contribute nothing, or plan.ts's overlay prune would wipe its directory.
  test("emits nothing for a retained (unchanged) skill", () => {
    const { files, ...retained } = skill();
    void files;
    expect(buildSkillFiles(retained, PLUGIN.slug, "plugins", META)).toEqual({});
  });
});

describe("marketplaceEntryInput", () => {
  test("points at the plugin directory", () => {
    expect(marketplaceEntryInput(PLUGIN, "plugins")).toEqual({
      name: "skills",
      source: "./plugins/skills",
      description: "Skills managed by Notion",
    });
  });
});

describe("mergeMarketplace", () => {
  const existing: Marketplace = {
    name: "test-skills",
    owner: { name: "Test Team" },
    plugins: [
      { name: "hello-world", source: "./plugins/hello-world", description: "hi" },
      { name: "old-skill", source: "./plugins/old-skill", description: "stale" },
    ],
  };

  test("preserves non-managed, adds managed, prunes removed", () => {
    const desired = [
      { name: "message-review", source: "./plugins/message-review", description: "d" },
    ];
    const controlled = new Set(["message-review", "old-skill"]); // old-skill was managed, now gone
    const merged = mergeMarketplace(existing, desired, controlled);
    const names = merged.plugins.map((p) => p.name);
    expect(names).toContain("hello-world"); // preserved
    expect(names).toContain("message-review"); // added
    expect(names).not.toContain("old-skill"); // pruned
  });

  test("managed entries are sorted for determinism", () => {
    const desired = [
      { name: "zebra", source: "./plugins/zebra", description: "z" },
      { name: "apple", source: "./plugins/apple", description: "a" },
    ];
    const merged = mergeMarketplace(existing, desired, new Set(["zebra", "apple"]));
    const managed = merged.plugins.filter((p) => p.name === "apple" || p.name === "zebra");
    expect(managed.map((p) => p.name)).toEqual(["apple", "zebra"]);
  });
});
