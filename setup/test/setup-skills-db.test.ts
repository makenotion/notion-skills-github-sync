import { describe, expect, test } from "bun:test";
import {
  buildCreateSkillsDbRequest,
  describeDatabaseCreationFailure,
  getSkillsPropertyKeys,
  parseCreatedSkillsDb,
} from "../skills-db.ts";

describe("createSkillsDb helpers", () => {
  test("builds a normal Public API request for a typed Skills database", () => {
    expect(buildCreateSkillsDbRequest({ dbName: "Team Skills", parentPageId: "page-id" })).toEqual({
      parent: { type: "page_id", page_id: "page-id" },
      database_type: "skills",
      title: [{ type: "text", text: { content: "Team Skills" } }],
    });
    expect(buildCreateSkillsDbRequest({ dbName: "Skills" }).parent).toEqual({
      type: "workspace",
      workspace: true,
    });
  });

  test("parses the structured create-database response", () => {
    expect(parseCreatedSkillsDb(JSON.stringify({
      id: "database-id",
      url: "https://www.notion.so/database-id",
      database_type: "skills",
      data_sources: [{ id: "data-source-id" }],
    }))).toEqual({
      databaseId: "database-id",
      databaseUrl: "https://www.notion.so/database-id",
      dataSourceId: "data-source-id",
    });
  });

  test("rejects a response that is not a typed Skills database", () => {
    expect(parseCreatedSkillsDb(JSON.stringify({
      id: "database-id",
      url: "https://www.notion.so/database-id",
      database_type: null,
      data_sources: [{ id: "data-source-id" }],
    }))).toBeNull();
  });

  test("formats API errors without suggesting the retired feature gate", () => {
    expect(describeDatabaseCreationFailure(
      JSON.stringify({
        object: "error",
        status: 403,
        code: "restricted_resource",
        message: "Endpoint unavailable.",
      }),
      "",
    )).toBe("Notion returned 403 restricted_resource Endpoint unavailable.");
  });

  test("preserves process stderr", () => {
    expect(describeDatabaseCreationFailure("not JSON", "permission denied\n"))
      .toBe("permission denied");
  });

  test("uses typed property IDs to handle localized display names", () => {
    expect(getSkillsPropertyKeys(JSON.stringify({
      properties: {
        "Nom de la compétence": { id: "title-id", type: "title" },
        Description: { id: "description-id", type: "rich_text" },
        Fichiers: { id: "files-id", type: "files" },
      },
    }))).toEqual({
      skillName: "title-id",
      description: "description-id",
      files: "files-id",
    });
  });
});
