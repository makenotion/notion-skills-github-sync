import { describe, expect, test } from "bun:test";
import { overwriteConfirmationMatches } from "../src/wizard/steps/decisions.ts";

describe("overwriteConfirmationMatches", () => {
  const repo = "acme-org/notion-skills";

  test("matches the exact repo name", () => {
    expect(overwriteConfirmationMatches(repo, repo)).toBe(true);
  });

  test("tolerates surrounding whitespace on the typed input", () => {
    expect(overwriteConfirmationMatches(`  ${repo}  `, repo)).toBe(true);
  });

  test("rejects empty / undefined input so Enter alone can't confirm", () => {
    expect(overwriteConfirmationMatches("", repo)).toBe(false);
    expect(overwriteConfirmationMatches(undefined, repo)).toBe(false);
  });

  test("rejects a near-miss (different repo)", () => {
    expect(overwriteConfirmationMatches("acme-org/notion-skill", repo)).toBe(false);
    expect(overwriteConfirmationMatches("notion-skills", repo)).toBe(false);
  });
});
