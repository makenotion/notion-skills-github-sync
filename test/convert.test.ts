import { describe, expect, test } from "bun:test";
import {
  stripLeadingFrontmatter,
  deriveDescription,
  buildSkillMarkdown,
  buildPluginJson,
  buildSyncMarker,
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
  test("uses slug as name and includes author", () => {
    const obj = JSON.parse(buildPluginJson(skill()));
    expect(obj).toEqual({
      name: "message-review",
      version: "1.0.0",
      description: "Review a message before sending.",
      author: { name: "Test Author" },
    });
  });

  test("defaults author when createdBy empty", () => {
    const obj = JSON.parse(buildPluginJson(skill({ createdBy: "" })));
    expect(obj.author.name).toBe("Cowork Skills");
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
