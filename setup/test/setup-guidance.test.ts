import { describe, expect, test } from "bun:test";
import {
  notionPatSettingHelp,
  notionConnectionSettingHelp,
  githubPatApprovalHelp,
} from "../guidance.ts";

// These strings encode the hard-won setup-call gotchas. Assert the concrete
// recovery instructions so they cannot silently drift.

describe("notionPatSettingHelp", () => {
  const msg = notionPatSettingHelp();
  test("gives the revised recovery steps", () => {
    expect(msg).toContain("Open settings");
    expect(msg).toContain("Connections > Manage");
    expect(msg).toContain("Limit who can create personal access tokens (PATs)");
  });
});

describe("notionConnectionSettingHelp", () => {
  const msg = notionConnectionSettingHelp();
  test("asks an admin to create the token", () => {
    expect(msg).toContain("have an admin");
    expect(msg).toContain("create a token for you");
  });
});

describe("githubPatApprovalHelp", () => {
  const msg = githubPatApprovalHelp("future-fuel/notion-skills");
  test("gives the exact org PAT approval path", () => {
    expect(msg).toContain(
      "Organization Settings → Personal access tokens → Pending requests",
    );
  });
  test("names the org and notes the token is scoped to only the skills repo", () => {
    expect(msg).toContain("future-fuel");
    expect(msg).toContain("future-fuel/notion-skills");
    expect(msg.toLowerCase()).toContain("only the future-fuel/notion-skills repository");
  });
});
