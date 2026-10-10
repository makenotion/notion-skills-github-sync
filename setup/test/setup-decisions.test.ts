import { describe, expect, test } from "bun:test";
import { normalizeNotionPageId } from "../skills-db.ts";

describe("normalizeNotionPageId", () => {
  test("accepts a Notion page URL and normalizes its compact ID", () => {
    expect(normalizeNotionPageId(
      "https://www.notion.so/Team-home-d89180e9158c4354bbab4e16038b751d",
    )).toBe("d89180e9-158c-4354-bbab-4e16038b751d");
  });

  test("accepts a hyphenated page ID", () => {
    expect(normalizeNotionPageId("d89180e9-158c-4354-bbab-4e16038b751d"))
      .toBe("d89180e9-158c-4354-bbab-4e16038b751d");
  });

  test("rejects a value without a page ID", () => {
    expect(normalizeNotionPageId("https://www.notion.so/Team-home")).toBeNull();
  });
});
