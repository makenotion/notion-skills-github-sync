import { describe, expect, test } from "bun:test";
import { apiBaseUrl, appBaseUrl, pageUrl } from "../src/notion/env.ts";

// One env axis, two hosts. They're tested together because the whole point of
// consolidating them is that `NOTION_ENV=dev` flips both at once.
describe("host resolution", () => {
  test("prod is special-cased; every other env follows the pattern", () => {
    expect(apiBaseUrl("prod")).toBe("https://api.notion.com");
    expect(apiBaseUrl("dev")).toBe("https://api-dev.notion.com");
    expect(apiBaseUrl("stg")).toBe("https://api-stg.notion.com");

    expect(appBaseUrl("prod")).toBe("https://www.notion.so");
    expect(appBaseUrl("dev")).toBe("https://app.dev.notion.com");
  });

  test("an explicit baseUrl wins, trailing slash and all", () => {
    expect(apiBaseUrl("prod", { baseUrl: "http://127.0.0.1:8080/" })).toBe("http://127.0.0.1:8080");
  });

  test("page links strip dashes from the id, as Notion's own URLs do", () => {
    expect(pageUrl("dev", "3b2b35e6-e67f-81c7-81a1-ee019dc316d9")).toBe(
      "https://app.dev.notion.com/p/3b2b35e6e67f81c781a1ee019dc316d9",
    );
  });
});
