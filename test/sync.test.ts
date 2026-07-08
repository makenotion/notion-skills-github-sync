import { describe, expect, test } from "bun:test";
import { resolveSkills } from "../src/sync.ts";
import type { Config } from "../src/config.ts";
import type { NotionClient, NotionSkillPage } from "../src/notion/types.ts";

const CONFIG: Config = {
  notionEnv: "dev",
  skillsDataSourceId: "ds",
  skillsDatabaseId: "db",
  changeRequestsDataSourceId: "",
  githubRepo: "owner/repo",
  githubBranch: "main",
  githubToken: undefined,
  pluginsDir: "plugins",
  authorName: "tester",
  authorEmail: "tester@example.com",
  injectUpdater: true,
  updaterSlug: "notion-skill-updater",
};

function fakeClient(pages: NotionSkillPage[]): NotionClient {
  return {
    listSkillPages: async () => pages,
    getPageBodyMarkdown: async (pageId) => `body for ${pageId}`,
  };
}

const mkPage = (over: Partial<NotionSkillPage>): NotionSkillPage => ({
  pageId: "page-1",
  name: "Skill One",
  description: "desc",
  published: true,
  createdBy: "Tester",
  lastEditedTime: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("resolveSkills pluginSlug assignment", () => {
  test("untagged skills each get their own plugin (pluginSlug = own slug)", async () => {
    const pages = [
      mkPage({ pageId: "a", name: "Meeting Notes", plugin: undefined }),
      mkPage({ pageId: "b", name: "Email Drafting", plugin: undefined }),
    ];
    const skills = await resolveSkills(fakeClient(pages), CONFIG);

    const bySlug = Object.fromEntries(skills.map((s) => [s.slug, s.pluginSlug]));
    expect(bySlug["meeting-notes"]).toBe("meeting-notes");
    expect(bySlug["email-drafting"]).toBe("email-drafting");
    // Two distinct plugins, not one shared "skills" plugin.
    expect(new Set(skills.map((s) => s.pluginSlug)).size).toBe(2);
  });

  test("tagged skills share the plugin from the Plugins property", async () => {
    const pages = [
      mkPage({ pageId: "a", name: "Meeting Notes", plugin: "Productivity" }),
      mkPage({ pageId: "b", name: "Email Drafting", plugin: "Productivity" }),
    ];
    const skills = await resolveSkills(fakeClient(pages), CONFIG);

    expect(skills.every((s) => s.pluginSlug === "productivity")).toBe(true);
  });

  test("a plugin tag that slugifies to empty falls back to the skill's own slug", async () => {
    const pages = [mkPage({ pageId: "a", name: "Meeting Notes", plugin: "!!!" })];
    const skills = await resolveSkills(fakeClient(pages), CONFIG);

    expect(skills[0]!.pluginSlug).toBe("meeting-notes");
  });

  test("only published skills are resolved", async () => {
    const pages = [
      mkPage({ pageId: "a", name: "Meeting Notes", published: true }),
      mkPage({ pageId: "b", name: "Draft", published: false }),
    ];
    const skills = await resolveSkills(fakeClient(pages), CONFIG);
    expect(skills.map((s) => s.slug)).toEqual(["meeting-notes"]);
  });
});
