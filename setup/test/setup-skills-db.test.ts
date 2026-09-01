import { describe, expect, test } from "bun:test";
import { describeTypedDbCreationFailure } from "../skills-db.ts";

describe("describeTypedDbCreationFailure", () => {
  test("explains a feature-gated typed Skills database endpoint", () => {
    expect(describeTypedDbCreationFailure(
      JSON.stringify({
        object: "error",
        status: 403,
        code: "restricted_resource",
        message: "Endpoint unavailable.",
      }),
      "",
    )).toBe(
      "Notion returned 403 restricted_resource Endpoint unavailable.\n\n" +
        "The typed Skills database API is unavailable to this workspace. " +
        "Ask the Notion Public API team to enable the `public_api_skills_plugins` " +
        "feature gate for the workspace (and confirm this connection can create " +
        "databases), then run `bun run setup` again.",
    );
  });

  test("preserves process stderr", () => {
    expect(describeTypedDbCreationFailure("not JSON", "permission denied\n"))
      .toBe("permission denied");
  });

  test("does not classify a successful typed-database response as an error", () => {
    expect(describeTypedDbCreationFailure(
      JSON.stringify({ result: "Created {{https://notion.so/p/0123456789abcdef0123456789abcdef}}" }),
      "",
    )).toBeNull();
  });
});
