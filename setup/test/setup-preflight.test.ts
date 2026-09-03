import { describe, expect, test } from "bun:test";
import {
  canCreateTopLevelNotionDatabase,
  getNtnLoginUrl,
} from "../steps/preflight.ts";

describe("canCreateTopLevelNotionDatabase", () => {
  test("accepts a direct person identity", () => {
    expect(canCreateTopLevelNotionDatabase(JSON.stringify({
      object: "user",
      type: "person",
    }))).toBe(true);
  });

  test("accepts the CLI PAT identity owned by a user", () => {
    expect(canCreateTopLevelNotionDatabase(JSON.stringify({
      object: "user",
      type: "bot",
      bot: { owner: { type: "user" } },
    }))).toBe(true);
  });

  test("rejects a workspace-owned internal connection", () => {
    expect(canCreateTopLevelNotionDatabase(JSON.stringify({
      object: "user",
      type: "bot",
      bot: { owner: { type: "workspace", workspace: true } },
    }))).toBe(false);
  });

  test("rejects malformed responses", () => {
    expect(canCreateTopLevelNotionDatabase("not json")).toBe(false);
  });
});

describe("getNtnLoginUrl", () => {
  test("extracts the URL that must be approved before polling", () => {
    expect(getNtnLoginUrl(
      "Open this URL in your browser to log in:\n\n  https://www.notion.so/workers/cli-login?verificationCode=ABC-123\n",
    )).toBe("https://www.notion.so/workers/cli-login?verificationCode=ABC-123");
  });

  test("returns null when login does not provide a URL", () => {
    expect(getNtnLoginUrl("Login unavailable")).toBeNull();
  });
});
