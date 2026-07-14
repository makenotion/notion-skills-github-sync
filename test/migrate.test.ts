import { describe, expect, test } from "bun:test";
import { parseCreateDatabaseResult } from "../src/wizard/skills-db.ts";
import {
  buildExtraPropertyDefinitions,
  buildRowProperties,
  classifyOldSchema,
} from "../src/migrate.ts";

const TOOLS_RUN_MARKDOWN =
  'Created database: <database url="{{https://app.dev.notion.com/p/174a41454acc4c6bb59090c2d6d99b9a}}" inline="false">\n' +
  "The title of this Database is: Skills\n" +
  "<data-sources>\n" +
  '<data-source url="{{collection://462f6fdc-ae82-411c-a6eb-867eb1b1379b}}">\n' +
  "</data-source>\n</data-sources>\n</database>";

describe("parseCreateDatabaseResult", () => {
  test("extracts the database id/url and data source id from the tools/run Markdown", () => {
    const parsed = parseCreateDatabaseResult(TOOLS_RUN_MARKDOWN);
    expect(parsed).not.toBeNull();
    expect(parsed!.databaseId).toBe("174a41454acc4c6bb59090c2d6d99b9a");
    expect(parsed!.databaseUrl).toBe(
      "https://app.dev.notion.com/p/174a41454acc4c6bb59090c2d6d99b9a",
    );
    expect(parsed!.dataSourceId).toBe("462f6fdc-ae82-411c-a6eb-867eb1b1379b");
  });

  test("returns null when the Markdown is missing the markers", () => {
    expect(parseCreateDatabaseResult("no markers here")).toBeNull();
  });
});

// The old (legacy) Test Skills schema: canonical roles A/B(/C) + user extras D/E.
const OLD_SCHEMA = {
  "Skill name": { id: "title", type: "title" },
  Description: { id: "%3EB%40K", type: "rich_text" },
  Author: { id: "eS%7Cx", type: "rich_text" },
  Published: { id: "%40gs%5E", type: "checkbox" },
  Plugins: {
    id: "gtyg",
    type: "select",
    select: { options: [{ name: "productivity", color: "blue" }] },
  },
  Version: { id: "xW%40%3A", type: "number", number: { format: "number" } },
  Created: { id: "ct01", type: "created_time" },
};

describe("classifyOldSchema", () => {
  test("splits canonical roles from extras (ABC + DE case)", () => {
    const { roleNames, extraNames } = classifyOldSchema(OLD_SCHEMA);
    expect(roleNames.name).toBe("Skill name");
    expect(roleNames.description).toBe("Description");
    expect(extraNames.sort()).toEqual(
      ["Author", "Created", "Plugins", "Published", "Version"].sort(),
    );
  });
});

describe("buildExtraPropertyDefinitions", () => {
  const { extraNames } = classifyOldSchema(OLD_SCHEMA);
  const { definitions, skipped } = buildExtraPropertyDefinitions(OLD_SCHEMA, extraNames);

  test("recreates user columns verbatim (type + options)", () => {
    expect(definitions.Author).toEqual({ rich_text: {} });
    expect(definitions.Version).toEqual({ number: { format: "number" } });
    expect(definitions.Plugins).toEqual({
      select: { options: [{ name: "productivity", color: "blue" }] },
    });
    expect(definitions.Published).toEqual({ checkbox: {} });
  });

  test("skips computed/system columns", () => {
    expect(skipped).toContain("Created");
    expect(definitions.Created).toBeUndefined();
  });

  test("ensures Published + Plugins even when the old DB lacked them", () => {
    const { definitions: defs } = buildExtraPropertyDefinitions(
      { "Skill name": { id: "title", type: "title" } },
      [],
    );
    expect(defs.Published).toEqual({ checkbox: {} });
    expect((defs.Plugins as any).select).toBeDefined();
  });

  test("downgrades status to select, preserving options", () => {
    const schema = {
      Stage: { id: "s1", type: "status", status: { options: [{ name: "Done", color: "green" }] } },
    };
    const { definitions: defs } = buildExtraPropertyDefinitions(schema, ["Stage"]);
    expect(defs.Stage).toEqual({ select: { options: [{ name: "Done", color: "green" }] } });
  });
});

describe("buildRowProperties", () => {
  const { roleNames, extraNames } = classifyOldSchema(OLD_SCHEMA);
  const { definitions } = buildExtraPropertyDefinitions(OLD_SCHEMA, extraNames);

  const oldProps = {
    "Skill name": { type: "title", title: [{ plain_text: "My Skill" }] },
    Description: { type: "rich_text", rich_text: [{ plain_text: "does things" }] },
    Author: { type: "rich_text", rich_text: [{ plain_text: "Ada" }] },
    Published: { type: "checkbox", checkbox: true },
    Plugins: { type: "select", select: { name: "productivity" } },
    Version: { type: "number", number: 3 },
  };

  test("maps canonical roles onto canonical names and copies extras", () => {
    const out: any = buildRowProperties(oldProps, roleNames, definitions);
    expect(out["Skill name"]).toEqual({ title: [{ text: { content: "My Skill" } }] });
    expect(out.Description).toEqual({ rich_text: [{ text: { content: "does things" } }] });
    expect(out.Author).toEqual({ rich_text: [{ text: { content: "Ada" } }] });
    expect(out.Published).toEqual({ checkbox: true });
    expect(out.Plugins).toEqual({ select: { name: "productivity" } });
    expect(out.Version).toEqual({ number: 3 });
  });

  test("does not attempt to set computed columns", () => {
    const out: any = buildRowProperties(oldProps, roleNames, definitions);
    expect(out.Created).toBeUndefined();
  });
});
