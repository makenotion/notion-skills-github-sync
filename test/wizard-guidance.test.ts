import { describe, expect, test } from "bun:test";
import {
  notionPatSettingHelp,
  notionConnectionSettingHelp,
  githubPatApprovalHelp,
  claudeGithubAppHelp,
} from "../src/wizard/guidance.ts";

// These strings encode the hard-won setup-call gotchas — assert the exact
// setting names / locations users need, so they can't silently drift.

describe("notionPatSettingHelp", () => {
  const msg = notionPatSettingHelp();
  test("names the blocking setting and its location", () => {
    expect(msg).toContain("Limit who can create personal access tokens");
    expect(msg).toContain("Admin Center → Connections → Manage");
  });
  test("notes the PAT can be re-restricted after setup", () => {
    expect(msg.toLowerCase()).toContain("re-restricted");
  });
});

describe("notionConnectionSettingHelp", () => {
  const msg = notionConnectionSettingHelp();
  test("names the internal-connections setting and location", () => {
    expect(msg).toContain("Limit who can create internal connections");
    expect(msg).toContain("Admin Center → Connections → Manage");
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

describe("claudeGithubAppHelp", () => {
  const msg = claudeGithubAppHelp("future-fuel/notion-skills");
  test("explains the 'Only select repositories' install requirement", () => {
    expect(msg).toContain("Only select repositories");
    expect(msg).toContain("future-fuel/notion-skills");
  });
  test("notes the repo must be visible to the person doing Claude setup", () => {
    expect(msg.toLowerCase()).toContain("collaborator");
  });
});
