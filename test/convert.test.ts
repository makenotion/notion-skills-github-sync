import { describe, expect, test } from "bun:test";
import {
  stripLeadingFrontmatter,
  deriveDescription,
  buildSkillMarkdown,
  buildPluginJson,
  buildSyncMarker,
  buildPluginFiles,
  mergeMarketplace,
  contentHash,
  type Marketplace,
  type NotionSourceMeta,
  type SkillInput,
} from "../src/convert.ts";

const META: NotionSourceMeta = {
  env: "dev",
  databaseId: "db123",
  skillsDataSourceId: "ds456",
};

const skill = (over: Partial<SkillInput> = {}): SkillInput => ({
  pageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "Message Review ",
  slug: "message-review",
  description: "Review a message before sending.",
  body: "Do the thing.",
  createdBy: "Test Author",
  pluginSlug: over.pluginSlug ?? "message-review",
  ...over,
});

describe("stripLeadingFrontmatter", () => {
  test("removes the ntn frontmatter block", () => {
    const md = "---\nCreated by: Pia\nDescription: ''\nSkill name: 'X '\n---\n\nBody starts here.\nMore.";
    expect(stripLeadingFrontmatter(md)).toBe("Body starts here.\nMore.");
  });

  test("no frontmatter is left intact (trimmed)", () => {
    expect(stripLeadingFrontmatter("\n\nJust body\n")).toBe("Just body");
  });
});

describe("deriveDescription", () => {
  test("uses the property when present", () => {
    const r = deriveDescription("A real description", "body");
    expect(r).toEqual({ description: "A real description", fallbackUsed: false });
  });

  test("falls back to first body paragraph, stripping markdown", () => {
    const r = deriveDescription("", "## Heading\n\n- **First** real line\nrest");
    expect(r.fallbackUsed).toBe(true);
    expect(r.description).toBe("First real line");
  });

  test("truncates long fallback", () => {
    const long = "x".repeat(300);
    const r = deriveDescription("", long, 50);
    expect(r.description.length).toBe(50);
    expect(r.description.endsWith("…")).toBe(true);
  });
});

describe("buildSkillMarkdown", () => {
  test("emits frontmatter + body", () => {
    expect(buildSkillMarkdown(skill({ body: "Step 1\nStep 2" }))).toBe(
      "---\ndescription: Review a message before sending.\n---\n\nStep 1\nStep 2\n",
    );
  });
});

describe("buildPluginJson", () => {
  test("uses the plugin slug as name and includes author", () => {
    const obj = JSON.parse(buildPluginJson(skill({ pluginSlug: "writing-tools" })));
    expect(obj).toEqual({
      name: "writing-tools",
      version: "1.0.0",
      description: "Review a message before sending.",
      author: { name: "Test Author" },
    });
  });

  test("defaults author when createdBy empty", () => {
    const obj = JSON.parse(buildPluginJson(skill({ createdBy: "" })));
    expect(obj.author.name).toBe("Cowork Skills");
  });

  test("prefers the plugin option description when set", () => {
    const obj = JSON.parse(
      buildPluginJson(skill({ pluginDescription: "Grouped writing tools." })),
    );
    expect(obj.description).toBe("Grouped writing tools.");
  });

  test("falls back to the skill description when the plugin description is blank", () => {
    const obj = JSON.parse(buildPluginJson(skill({ pluginDescription: "   " })));
    expect(obj.description).toBe("Review a message before sending.");
  });
});

describe("buildSyncMarker", () => {
  test("carries the Notion back-reference and a content hash", () => {
    const obj = JSON.parse(buildSyncMarker(skill(), META));
    expect(obj.source).toBe("notion");
    expect(obj.notion.pageId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(obj.notion.skillsDataSourceId).toBe("ds456");
    expect(obj.notion.url).toBe(
      "https://app.dev.notion.com/p/aaaaaaaabbbbccccddddeeeeeeeeeeee",
    );
    expect(obj.skill).toEqual({ slug: "message-review", name: "Message Review" });
    expect(obj.contentHash).toMatch(/^sha256:/);
  });

  test("prod env uses www.notion.so", () => {
    const obj = JSON.parse(buildSyncMarker(skill(), { ...META, env: "prod" }));
    expect(obj.notion.url.startsWith("https://www.notion.so/p/")).toBe(true);
  });

  test("hash is stable across runs but changes with content", () => {
    const a = contentHash({ name: "n", description: "d", body: "b" });
    const b = contentHash({ name: "n", description: "d", body: "b" });
    const c = contentHash({ name: "n", description: "d", body: "b2" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("buildPluginFiles with extra (zip) files", () => {
  test("lays extra files into the skill dir and always wins with generated SKILL.md/marker", () => {
    const files = buildPluginFiles(
      skill({
        extraFiles: {
          "SKILL.md": new TextEncoder().encode("placeholder from zip"),
          "scripts/run.py": new TextEncoder().encode("print('hi')"),
          "references/notes.md": new TextEncoder().encode("# ref"),
        },
      }),
      "plugins",
      META,
    );

    // Extra files land under the skill dir.
    expect(Object.keys(files)).toContain("plugins/message-review/skills/message-review/scripts/run.py");
    expect(Object.keys(files)).toContain("plugins/message-review/skills/message-review/references/notes.md");

    // The generated SKILL.md overrides the zip's placeholder (Notion wins).
    const skillMd = files["plugins/message-review/skills/message-review/SKILL.md"]!;
    expect(typeof skillMd).toBe("string");
    expect(skillMd).toContain("Do the thing.");
    expect(skillMd).not.toContain("placeholder from zip");

    // Marker is present.
    expect(Object.keys(files)).toContain(
      "plugins/message-review/skills/message-review/.notion-sync.json",
    );
  });

  test("no extraFiles emits SKILL.md, marker, and one plugin.json per client", () => {
    const files = buildPluginFiles(skill(), "plugins", META);
    expect(Object.keys(files).sort()).toEqual([
      "plugins/message-review/.claude-plugin/plugin.json",
      "plugins/message-review/.codex-plugin/plugin.json",
      "plugins/message-review/.cursor-plugin/plugin.json",
      "plugins/message-review/skills/message-review/.notion-sync.json",
      "plugins/message-review/skills/message-review/SKILL.md",
    ]);
    // Every client's plugin.json has identical content (shared metadata).
    const claude = files["plugins/message-review/.claude-plugin/plugin.json"];
    expect(files["plugins/message-review/.cursor-plugin/plugin.json"]).toBe(claude!);
    expect(files["plugins/message-review/.codex-plugin/plugin.json"]).toBe(claude!);
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
