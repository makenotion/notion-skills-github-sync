import { describe, expect, test } from "bun:test";
import {
  computeMigrationMapping,
  desiredExtraProperties,
  findPropertyByRole,
  isTypedSkillsDb,
  propertyValueToWritePayload,
  resolveSkillFields,
  type PropertyLike,
} from "../src/notion/skill-schema.ts";
import { parseTypedDbCreation } from "../src/wizard/skills-db.ts";
import { buildMigratedRowProperties, compareDesiredFiles } from "../src/migrate.ts";

// --- Fixtures -----------------------------------------------------------------

const rt = (s: string) => [{ type: "text", plain_text: s, text: { content: s } }];

// A row from a typed skills DB: canonical special ids (URL-encoded, as the REST
// API returns them), display names possibly renamed by the user.
const typedRow: Record<string, PropertyLike> = {
  "My skill": { id: "title", type: "title", title: rt("Typed Skill") },
  Docs: {
    id: "notion%3A%2F%2Fskills%2Fdescription_property",
    type: "rich_text",
    rich_text: rt("A typed description"),
  },
  Files: { id: "notion%3A%2F%2Fskills%2Ffiles_property", type: "files", files: [] },
  Author: {
    id: "notion%3A%2F%2Fskills%2Fcreated_by_property",
    type: "created_by",
    created_by: { id: "u1", name: "Ada" },
  },
  Published: { id: "_TjA", type: "checkbox", checkbox: true },
  Plugins: { id: "jv_z", type: "select", select: { name: "productivity" } },
};

// A row from a legacy (pre-typed) DB: plain ids, canonical display names.
const legacyRow: Record<string, PropertyLike> = {
  "Skill name": { id: "title", type: "title", title: rt("Legacy Skill") },
  Description: { id: "aBcD", type: "rich_text", rich_text: rt("A legacy description") },
  "Created by": { id: "eFgH", type: "created_by", created_by: { id: "u2", name: "Grace" } },
  Published: { id: "iJkL", type: "checkbox", checkbox: false },
  Plugins: { id: "mNoP", type: "select", select: null },
};

// --- Role resolution ------------------------------------------------------------

describe("resolveSkillFields", () => {
  test("typed rows resolve by canonical id even when display names are renamed", () => {
    expect(resolveSkillFields(typedRow)).toEqual({
      name: "Typed Skill",
      description: "A typed description",
      published: true,
      createdBy: "Ada",
      plugin: "productivity",
    });
  });

  test("legacy rows resolve via the legacy name fallback", () => {
    expect(resolveSkillFields(legacyRow)).toEqual({
      name: "Legacy Skill",
      description: "A legacy description",
      published: false,
      createdBy: "Grace",
      plugin: undefined,
    });
  });

  test("a never-renamed 'Name' title property still resolves the name role", () => {
    const row: Record<string, PropertyLike> = {
      Name: { id: "title", type: "title", title: rt("Plain") },
    };
    expect(resolveSkillFields(row).name).toBe("Plain");
    expect(findPropertyByRole(row, "name")?.[0]).toBe("Name");
  });

  test("missing properties resolve to safe defaults", () => {
    expect(resolveSkillFields({})).toEqual({
      name: "",
      description: "",
      published: false,
      createdBy: "",
      plugin: undefined,
    });
  });
});

describe("isTypedSkillsDb", () => {
  test("detects typed schemas by canonical special ids", () => {
    expect(isTypedSkillsDb(typedRow)).toBe(true);
    expect(isTypedSkillsDb(legacyRow)).toBe(false);
    expect(isTypedSkillsDb({})).toBe(false);
  });
});

// --- Setup extras ----------------------------------------------------------------

describe("desiredExtraProperties", () => {
  test("describes Published + Plugins with the sample options", () => {
    const props = desiredExtraProperties();
    expect(props.Published).toEqual({ checkbox: {} });
    expect(props.Plugins).toEqual({
      select: {
        options: [
          { name: "writing-assistant" },
          { name: "research-tools" },
          { name: "productivity" },
        ],
      },
    });
  });
});

// --- tools/run Markdown parsing ---------------------------------------------------

describe("parseTypedDbCreation", () => {
  const devResult =
    'Created database: <database url="{{https://app.dev.notion.com/p/3ae95da9b36d41ffb2cd8b4f347d473b}}" inline="false">\n' +
    'Here are the Database\'s Data Sources:\n' +
    '<data-source url="{{collection://f43fa8d1-5e79-4f51-be9f-3a692dcd0814}}">\n</data-source>';

  test("extracts the database url/id and data source id", () => {
    expect(parseTypedDbCreation(devResult)).toEqual({
      databaseId: "3ae95da9-b36d-41ff-b2cd-8b4f347d473b",
      databaseUrl: "https://app.dev.notion.com/p/3ae95da9b36d41ffb2cd8b4f347d473b",
      dataSourceId: "f43fa8d1-5e79-4f51-be9f-3a692dcd0814",
    });
  });

  test("tolerates prod-style urls without /p/", () => {
    const prod =
      'url="{{https://www.notion.so/0123456789abcdef0123456789abcdef}}"\n' +
      "{{collection://f43fa8d1-5e79-4f51-be9f-3a692dcd0814}}";
    expect(parseTypedDbCreation(prod)?.databaseId).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
  });

  test("returns null when either id is missing", () => {
    expect(parseTypedDbCreation("no ids here")).toBeNull();
    expect(parseTypedDbCreation('{{https://x.com/p/3ae95da9b36d41ffb2cd8b4f347d473b}}')).toBeNull();
  });
});

// --- Migration mapping (the ABC + DE case) -----------------------------------------

describe("computeMigrationMapping", () => {
  const oldSchema: Record<string, PropertyLike> = {
    "Skill name": { id: "title", type: "title", title: {} },
    Description: { id: "aB", type: "rich_text", rich_text: {} },
    "Created by": { id: "cD", type: "created_by", created_by: {} },
    Published: { id: "eF", type: "checkbox", checkbox: {} },
    Plugins: {
      id: "gH",
      type: "select",
      select: { options: [{ id: "opt1", name: "productivity", color: "blue" }] },
    },
    Team: { id: "iJ", type: "multi_select", multi_select: { options: [{ id: "x", name: "eng", color: "red" }] } },
    Priority: { id: "kL", type: "number", number: { format: "number" } },
    Stage: { id: "mN", type: "status", status: { options: [] } },
  };

  test("maps canonical roles and recreates everything else verbatim", () => {
    const mapping = computeMigrationMapping(oldSchema);
    expect(mapping.roles).toEqual({
      name: "Skill name",
      description: "Description",
      createdBy: "Created by",
    });
    expect(Object.keys(mapping.extras).sort()).toEqual([
      "Plugins", "Priority", "Published", "Team",
    ]);
    // Select options survive minus their server-assigned ids.
    expect(mapping.extras.Plugins).toEqual({
      select: { options: [{ name: "productivity", color: "blue" }] },
    });
    expect(mapping.extras.Priority).toEqual({ number: { format: "number" } });
    // status can't be created via the API -> skipped with a reason.
    expect(mapping.skipped).toHaveLength(1);
    expect(mapping.skipped[0]?.name).toBe("Stage");
  });

  test("an already-typed schema claims roles by canonical id", () => {
    const mapping = computeMigrationMapping(typedRow);
    expect(mapping.roles.name).toBe("My skill");
    expect(mapping.roles.description).toBe("Docs");
    expect(mapping.roles.files).toBe("Files");
    expect(Object.keys(mapping.extras).sort()).toEqual(["Plugins", "Published"]);
  });
});

// --- Value copying -------------------------------------------------------------------

describe("propertyValueToWritePayload", () => {
  test("copies writable types", () => {
    expect(propertyValueToWritePayload({ type: "checkbox", checkbox: true })).toEqual({ checkbox: true });
    expect(
      propertyValueToWritePayload({ type: "select", select: { id: "x", name: "a", color: "red" } }),
    ).toEqual({ select: { name: "a" } });
    expect(
      propertyValueToWritePayload({ type: "multi_select", multi_select: [{ id: "x", name: "a" }] }),
    ).toEqual({ multi_select: [{ name: "a" }] });
    expect(
      propertyValueToWritePayload({ type: "relation", relation: [{ id: "p1" }] }),
    ).toEqual({ relation: [{ id: "p1" }] });
    expect(propertyValueToWritePayload({ type: "number", number: 3 })).toEqual({ number: 3 });
  });

  test("returns null for empty selects and system/computed types", () => {
    expect(propertyValueToWritePayload({ type: "select", select: null })).toBeNull();
    expect(propertyValueToWritePayload({ type: "created_by", created_by: { id: "u" } })).toBeNull();
    expect(propertyValueToWritePayload({ type: "formula", formula: { number: 1 } })).toBeNull();
    expect(propertyValueToWritePayload({ type: "last_edited_time", last_edited_time: "t" })).toBeNull();
  });
});

describe("buildMigratedRowProperties", () => {
  test("writes canonical roles under canonical names and extras under their own", () => {
    const mapping = computeMigrationMapping({
      "Skill name": legacyRow["Skill name"]!,
      Description: legacyRow.Description!,
      "Created by": legacyRow["Created by"]!,
      Published: legacyRow.Published!,
      Plugins: legacyRow.Plugins!,
    });
    const props = buildMigratedRowProperties(legacyRow, mapping);
    expect(Object.keys(props).sort()).toEqual(["Description", "Published", "Skill name"]);
    expect(props.Published).toEqual({ checkbox: false });
    // Empty select + read-only created_by are skipped.
    expect(props.Plugins).toBeUndefined();
  });
});

// --- Content parity -----------------------------------------------------------------

describe("compareDesiredFiles", () => {
  const marker = (pageId: string, hash: string) =>
    JSON.stringify({
      source: "notion",
      notion: { pageId, url: `https://x/p/${pageId}` },
      skill: { slug: "s", name: "S" },
      contentHash: hash,
    });
  const plugin = (author: string) =>
    JSON.stringify({ name: "s", version: "1.0.0", description: "d", author: { name: author } });

  test("identical modulo marker provenance and plugin author", () => {
    const res = compareDesiredFiles(
      {
        "p/s/skills/s/SKILL.md": "---\ndescription: d\n---\n\nbody\n",
        "p/s/skills/s/.notion-sync.json": marker("old", "sha256:aa"),
        "p/s/.claude-plugin/plugin.json": plugin("Old Author"),
      },
      {
        "p/s/skills/s/SKILL.md": "---\ndescription: d\n---\n\nbody\n",
        "p/s/skills/s/.notion-sync.json": marker("new", "sha256:aa"),
        "p/s/.claude-plugin/plugin.json": plugin("New Author"),
      },
    );
    expect(res.identical).toBe(true);
    expect(res.diffs).toEqual([]);
    expect(res.authorChanges).toEqual([
      { path: "p/s/.claude-plugin/plugin.json", from: "Old Author", to: "New Author" },
    ]);
  });

  test("flags content drift: changed hash, changed body, missing files", () => {
    const res = compareDesiredFiles(
      {
        "a/SKILL.md": "one",
        "a/.notion-sync.json": marker("old", "sha256:aa"),
        "only-old.md": "x",
      },
      {
        "a/SKILL.md": "two",
        "a/.notion-sync.json": marker("new", "sha256:bb"),
        "only-new.md": "y",
      },
    );
    expect(res.identical).toBe(false);
    expect(res.diffs.sort()).toEqual([
      "a/.notion-sync.json", "a/SKILL.md", "only-new.md", "only-old.md",
    ]);
  });
});
