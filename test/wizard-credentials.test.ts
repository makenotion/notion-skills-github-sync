import { describe, expect, test } from "bun:test";
import { buildPatUrl, PAT_EXPIRES_IN_DAYS } from "../src/wizard/steps/credentials.ts";
import { bodyToBlocks } from "../src/wizard/skills-db.ts";

describe("buildPatUrl", () => {
  test("prefills every supported parameter for the fine-grained PAT form", () => {
    const url = new URL(buildPatUrl("acme-org/notion-skills"));
    expect(url.origin + url.pathname).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(url.searchParams.get("name")).toBe("Notion Skills Sync");
    expect(url.searchParams.get("description")).toBe(
      "Pushes synced skill plugins to acme-org/notion-skills",
    );
    expect(url.searchParams.get("target_name")).toBe("acme-org");
    expect(url.searchParams.get("expires_in")).toBe(String(PAT_EXPIRES_IN_DAYS));
    expect(url.searchParams.get("contents")).toBe("write");
  });

  test("expires_in stays within GitHub's allowed 1-366 range", () => {
    expect(PAT_EXPIRES_IN_DAYS).toBeGreaterThanOrEqual(1);
    expect(PAT_EXPIRES_IN_DAYS).toBeLessThanOrEqual(366);
  });

  // A preset value makes the form select a ready-made option instead of the
  // Custom date field, avoiding the silent inline date-validation error (and
  // org lifetime-policy rejections) that a 366-day custom date can trigger.
  test("expires_in is one of GitHub's built-in expiration presets", () => {
    const githubExpirationPresets = [7, 30, 60, 90];
    expect(githubExpirationPresets).toContain(PAT_EXPIRES_IN_DAYS);
  });
});

describe("bodyToBlocks", () => {
  test("maps markdown-lite lines to the right Notion block types", () => {
    const blocks = bodyToBlocks(
      "# Title\n\n## Section\nplain paragraph\n- bullet item\n1. first step",
    ) as Array<Record<string, any>>;

    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "heading_2",
      "paragraph",
      "bulleted_list_item",
      "numbered_list_item",
    ]);
    expect(blocks[0]!.heading_1.rich_text[0].text.content).toBe("Title");
    expect(blocks[3]!.bulleted_list_item.rich_text[0].text.content).toBe(
      "bullet item",
    );
    expect(blocks[4]!.numbered_list_item.rich_text[0].text.content).toBe(
      "first step",
    );
  });

  test("skips blank lines", () => {
    expect(bodyToBlocks("a\n\n\nb")).toHaveLength(2);
  });
});
