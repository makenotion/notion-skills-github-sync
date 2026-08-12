import { describe, expect, test } from "bun:test";
import { mergeEnvFile } from "../../src/env-file.ts";

// The deploy step writes .env with this. Never overwriting an existing key is
// the load-bearing property: the file is the user's, and a half-written .env is
// worse than none.

describe("mergeEnvFile", () => {
  test("appends new keys and never overwrites ones already present", () => {
    const existing = "# mine\nGITHUB_REPO=me/mine\nNOTION_ENV=dev\n";
    const merged = mergeEnvFile(existing, [
      "# Written by `bun run setup`.",
      "NOTION_ENV=prod",
      "GITHUB_BRANCH=main",
      "PLUGINS_DIR=plugins",
    ]);

    expect(merged.written).toEqual(["GITHUB_BRANCH", "PLUGINS_DIR"]);
    expect(merged.skipped).toEqual(["NOTION_ENV"]);
    // The existing values survive verbatim; only the new keys are added.
    expect(merged.content).toBe(
      "# mine\nGITHUB_REPO=me/mine\nNOTION_ENV=dev\n\n" +
        "# Written by `bun run setup`.\nGITHUB_BRANCH=main\nPLUGINS_DIR=plugins\n",
    );
  });

  test("leaves the file untouched when every key is already set", () => {
    const existing = "GITHUB_REPO=me/mine\n";
    const merged = mergeEnvFile(existing, ["# header", "GITHUB_REPO=other/repo"]);

    expect(merged.content).toBe(existing);
    expect(merged.written).toEqual([]);
    expect(merged.skipped).toEqual(["GITHUB_REPO"]);
  });

  test("writes a fresh file with no leading blank line", () => {
    const merged = mergeEnvFile("", ["# header", "GITHUB_REPO=me/mine"]);
    expect(merged.content).toBe("# header\nGITHUB_REPO=me/mine\n");
    expect(merged.written).toEqual(["GITHUB_REPO"]);
  });

  test("commented-out keys don't count as present", () => {
    const merged = mergeEnvFile("#GITHUB_REPO=old\n", ["GITHUB_REPO=me/mine"]);
    expect(merged.written).toEqual(["GITHUB_REPO"]);
    expect(merged.content).toContain("GITHUB_REPO=me/mine");
  });
});
