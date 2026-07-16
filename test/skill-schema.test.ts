import { describe, expect, test } from "bun:test";
import {
  desiredExtraProperties,
  findPropertyByRole,
  isTypedSkillsDb,
  resolveSkillFields,
  type PropertyLike,
} from "../src/notion/skill-schema.ts";
import { parseTypedDbCreation } from "../src/wizard/skills-db.ts";

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
