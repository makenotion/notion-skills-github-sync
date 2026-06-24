import { describe, expect, test } from "bun:test";
import { pageMarkdownToBody } from "../src/notion/ntn-adapter.ts";

describe("pageMarkdownToBody", () => {
  test("returns markdown from the API response without frontmatter parsing", () => {
    expect(
      pageMarkdownToBody({
        markdown: "---\nnot frontmatter: just content\n---\n\nBody",
      }),
    ).toBe("---\nnot frontmatter: just content\n---\n\nBody");
  });
});
