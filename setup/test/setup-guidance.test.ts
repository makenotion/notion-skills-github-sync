import { describe, expect, test } from "bun:test";
import {
  notionPatSettingHelp,
  notionConnectionSettingHelp,
  githubPatApprovalHelp,
  claudeGithubAppHelp,
  claudeMarketplaceRegistrationHelp,
  CLAUDE_PLUGINS_GUIDE,
} from "../guidance.ts";

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

describe("claudeMarketplaceRegistrationHelp", () => {
  const repo = "future-fuel/notion-skills";
  const msg = claudeMarketplaceRegistrationHelp(repo);

  test("names the org Plugins settings landing spot and the skills repo", () => {
    expect(msg).toContain("Organization settings");
    expect(msg).toContain("Plugins");
    expect(msg).toContain(repo);
  });

  // The whole point of this rewrite (NGS-41): the target UI churns, so the
  // instructions must flag that and defer to Claude's own guide rather than
  // encode a click-by-click walkthrough that goes stale.
  test("flags that the UI changes and defers to Claude's own guide", () => {
    expect(msg.toLowerCase()).toContain("changes often");
    expect(msg).toContain("source of truth");
    expect(msg).toContain(CLAUDE_PLUGINS_GUIDE);
  });

  // The observed setup-call bug: choosing GitHub bounced the admin through a
  // sign-in and back to the plugins list, needing a second click-through.
  test("captures the sign-in / kick-back workaround", () => {
    expect(msg.toLowerCase()).toContain("sign-in");
    expect(msg.toLowerCase()).toContain("plugins list");
    expect(msg).toContain("Add plugin");
  });

  test("notes the auto-sync access requirements and the on-demand Update path", () => {
    expect(msg).toContain("Sync automatically");
    expect(msg).toContain("Webhooks");
    expect(msg).toContain("Update");
  });

  test("keeps the plan / role / feature prerequisites", () => {
    expect(msg).toContain("Team or Enterprise");
    expect(msg).toContain("Owner");
    expect(msg).toContain("Cowork + Skills");
  });
});
