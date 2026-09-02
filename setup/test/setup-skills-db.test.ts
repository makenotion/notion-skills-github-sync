import { describe, expect, test } from "bun:test";
import { describeTypedDbCreationFailure, parseCreatedDatabase } from "../skills-db.ts";

describe("describeTypedDbCreationFailure", () => {
  test("explains a connection that cannot create databases", () => {
    expect(describeTypedDbCreationFailure(
      JSON.stringify({
        object: "error",
        status: 403,
        code: "restricted_resource",
        message: "Insufficient permissions for this endpoint.",
      }),
      "",
    )).toBe(
      "Notion returned 403 restricted_resource Insufficient permissions for this endpoint.\n\n" +
        "This connection cannot create databases here. Give the integration the " +
        "`Insert content` capability and share the parent page with it, then run " +
        "`bun run setup` again.",
    );
  });

  test("preserves process stderr", () => {
    expect(describeTypedDbCreationFailure("not JSON", "permission denied\n"))
      .toBe("permission denied");
  });

  test("does not classify a created database as an error", () => {
    expect(describeTypedDbCreationFailure(
      JSON.stringify({ object: "database", id: "0123", data_sources: [] }),
      "",
    )).toBeNull();
  });
});

describe("parseCreatedDatabase", () => {
  const created = {
    object: "database",
    id: "01234567-89ab-cdef-0123-456789abcdef",
    url: "https://www.notion.so/0123456789abcdef0123456789abcdef",
    database_type: "skills",
    data_sources: [{ id: "fedcba98-7654-3210-fedc-ba9876543210", name: "Skills" }],
  };

  test("reads the ids setup needs from a POST /v1/databases response", () => {
    expect(parseCreatedDatabase(JSON.stringify(created))).toEqual({
      databaseId: "01234567-89ab-cdef-0123-456789abcdef",
      databaseUrl: "https://www.notion.so/0123456789abcdef0123456789abcdef",
      dataSourceId: "fedcba98-7654-3210-fedc-ba9876543210",
    });
  });

  test("rejects a database with no data source", () => {
    expect(parseCreatedDatabase(JSON.stringify({ ...created, data_sources: [] }))).toBeNull();
  });

  test("rejects non-database and non-JSON output", () => {
    expect(parseCreatedDatabase(JSON.stringify({ object: "error", status: 400 }))).toBeNull();
    expect(parseCreatedDatabase("Created {{https://notion.so/p/abc}}")).toBeNull();
  });
});
