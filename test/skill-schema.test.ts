import { describe, expect, test } from "bun:test";
import {
  CANONICAL,
  desiredExtraProperties,
  isTypedSkillsDb,
  normalizePropId,
  readCheckbox,
  readCreatedByName,
  readRichText,
  readSelectName,
  readTitle,
  resolveSkillProps,
  SAMPLE_PLUGIN_OPTIONS,
} from "../src/notion/skill-schema.ts";

// A typed skills DB carries canonical `notion://skills/*` ids (URL-encoded by
// REST) plus our extras resolved by name.
const typedRow = () => ({
  "Skill name": { id: "title", type: "title", title: [{ plain_text: "Typed Skill" }] },
  Description: {
    id: "notion%3A%2F%2Fskills%2Fdescription_property",
    type: "rich_text",
    rich_text: [{ plain_text: "A typed description" }],
  },
  "Created by": {
    id: "notion%3A%2F%2Fskills%2Fcreated_by_property",
    type: "created_by",
    created_by: { name: "Ada" },
  },
  Files: { id: "notion%3A%2F%2Fskills%2Ffiles_property", type: "files", files: [] },
  Published: { id: "ejc%3D", type: "checkbox", checkbox: true },
  Plugins: { id: "Um%60d", type: "select", select: { name: "productivity" } },
});

// A legacy DB names the same roles but with random ids.
const legacyRow = () => ({
  "Skill name": { id: "title", type: "title", title: [{ plain_text: "Legacy Skill" }] },
  Description: { id: "%3EB%40K", type: "rich_text", rich_text: [{ plain_text: "Legacy desc" }] },
  "Created by": { id: "abc1", type: "created_by", created_by: { name: "Grace" } },
  Published: { id: "%40gs%5E", type: "checkbox", checkbox: false },
  Plugins: { id: "gtyg", type: "select", select: { name: "research-tools" } },
});

describe("normalizePropId", () => {
  test("decodes URL-encoded canonical ids", () => {
    expect(normalizePropId("notion%3A%2F%2Fskills%2Fdescription_property")).toBe(
      CANONICAL.description,
    );
  });
  test("leaves plain ids untouched", () => {
    expect(normalizePropId("title")).toBe("title");
  });
  test("does not throw on malformed percent-encoding", () => {
    expect(normalizePropId("100%")).toBe("100%");
  });
});

describe("resolveSkillProps + readers (typed DB)", () => {
  test("resolves every role via canonical ids", () => {
    const f = resolveSkillProps(typedRow());
    expect(readTitle(f.name)).toBe("Typed Skill");
    expect(readRichText(f.description)).toBe("A typed description");
    expect(readCreatedByName(f.createdBy)).toBe("Ada");
    expect(readCheckbox(f.published)).toBe(true);
    expect(readSelectName(f.plugins)).toBe("productivity");
  });
});

describe("resolveSkillProps + readers (legacy DB)", () => {
  test("falls back to display-name lookup", () => {
    const f = resolveSkillProps(legacyRow());
    expect(readTitle(f.name)).toBe("Legacy Skill");
    expect(readRichText(f.description)).toBe("Legacy desc");
    expect(readCreatedByName(f.createdBy)).toBe("Grace");
    expect(readCheckbox(f.published)).toBe(false);
    expect(readSelectName(f.plugins)).toBe("research-tools");
  });

  test("resolves description even when the role is renamed but the legacy name matches", () => {
    const f = resolveSkillProps(legacyRow());
    expect(readRichText(f.description)).toBe("Legacy desc");
  });
});

describe("isTypedSkillsDb", () => {
  test("true when canonical description + files ids present", () => {
    expect(isTypedSkillsDb(typedRow())).toBe(true);
  });
  test("false for a legacy schema", () => {
    expect(isTypedSkillsDb(legacyRow())).toBe(false);
  });
});

describe("desiredExtraProperties", () => {
  test("emits Published checkbox + Plugins select with sample options by default", () => {
    const props = desiredExtraProperties() as any;
    expect(props.Published).toEqual({ checkbox: {} });
    expect(props.Plugins.select.options.map((o: any) => o.name)).toEqual([
      ...SAMPLE_PLUGIN_OPTIONS,
    ]);
  });
  test("accepts custom plugin options", () => {
    const props = desiredExtraProperties(["a", "b"]) as any;
    expect(props.Plugins.select.options).toEqual([{ name: "a" }, { name: "b" }]);
  });
});
