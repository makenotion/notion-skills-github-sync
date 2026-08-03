import { describe, expect, test } from "bun:test";
import { gzipSync } from "fflate";
import { resolveSkills, type SkillsApiLike } from "../src/sync.ts";
import { buildSyncMarker, type NotionSourceMeta, type PluginInfo } from "../src/convert.ts";
import { gitBlobSha } from "../src/diff.ts";
import type { SkillDirectorySummary } from "../src/notion/skills-api.ts";
import { makeTar } from "./tar-helper.ts";

const META: NotionSourceMeta = { env: "dev", databaseId: "db", skillsDataSourceId: "ds" };
const PLUGIN: PluginInfo = {
  slug: "skills",
  description: "Skills managed by Notion",
  author: "Notion Workspace Skills",
};

const dir = (name: string, versionId: string): SkillDirectorySummary => ({
  id: `dir-${name}`,
  name,
  description: `desc ${name}`,
  updated_at: "2026-07-24T00:00:00.000Z",
  version_id: versionId,
});

// Records which directories actually had an archive built for them — building
// one is expensive server-side work, so "was this called" is the assertion that
// matters for the version_id fast path.
function fakeApi(archives: Record<string, Uint8Array>): SkillsApiLike & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    async listPlugins() {
      return [];
    },
    async getDirectoryArchive(id: string) {
      fetched.push(id);
      const bytes = archives[id];
      if (!bytes) throw new Error(`no archive stubbed for ${id}`);
      // Hand back a data: URL so the download path runs for real.
      return { url: `data:application/gzip;base64,${Buffer.from(bytes).toString("base64")}` };
    },
  };
}

const archiveFor = (title: string, body: string) =>
  gzipSync(makeTar([{ name: `${title}/SKILL.md`, data: body }]));

const MARKER = "plugins/skills/skills/alpha/.notion-sync.json";
const SKILL_MD = "plugins/skills/skills/alpha/SKILL.md";

// The base tree as the sync sees it: path -> git blob sha. The marker's sha is
// what the fast path compares against, so it has to be the real hash of
// whatever marker text the repo is holding.
const syncedTree = (markerText: string) =>
  new Map([
    [MARKER, gitBlobSha(markerText)],
    [SKILL_MD, gitBlobSha("body")],
  ]);

const markerFor = (versionId: string, meta: NotionSourceMeta = META) =>
  buildSyncMarker(
    { directoryId: "dir-alpha", name: "alpha", slug: "alpha", description: "desc alpha", versionId },
    meta,
  );

describe("resolveSkills", () => {
  test("downloads and extracts a skill the repo has never seen", async () => {
    const api = fakeApi({ "dir-alpha": archiveFor("Alpha", "hello") });
    const skills = await resolveSkills({
      directories: [dir("alpha", "v1")],
      plugin: PLUGIN,
      api,
      existing: new Map(),
      pluginsDir: "plugins",
      meta: META,
    });

    expect(api.fetched).toEqual(["dir-alpha"]);
    expect(skills).toHaveLength(1);
    expect(new TextDecoder().decode(skills[0]!.files!["SKILL.md"] as Uint8Array)).toBe("hello");
    expect(skills[0]!.versionId).toBe("v1");
  });

  // The point of version_id: an unchanged skill costs one cheap marker read
  // instead of a server-side render + attachment fetch + tarball upload.
  test("skips the archive when the repo's marker already matches", async () => {
    const api = fakeApi({});

    const skills = await resolveSkills({
      directories: [dir("alpha", "v1")],
      plugin: PLUGIN,
      api,
      existing: syncedTree(markerFor("v1")),
      pluginsDir: "plugins",
      meta: META,
    });

    expect(api.fetched).toEqual([]);
    expect(skills[0]!.files).toBeUndefined();
  });

  test("re-downloads when the version_id moved", async () => {
    const api = fakeApi({ "dir-alpha": archiveFor("Alpha", "updated") });

    const skills = await resolveSkills({
      directories: [dir("alpha", "v1")],
      plugin: PLUGIN,
      api,
      existing: syncedTree(markerFor("v0")), // repo still holds the previous version
      pluginsDir: "plugins",
      meta: META,
    });

    expect(api.fetched).toEqual(["dir-alpha"]);
    expect(new TextDecoder().decode(skills[0]!.files!["SKILL.md"] as Uint8Array)).toBe("updated");
  });

  // The marker embeds the Notion env / ids too, so a config change has to force
  // a rewrite even though the skill content itself is untouched.
  test("re-downloads when the marker would change for a non-content reason", async () => {
    const api = fakeApi({ "dir-alpha": archiveFor("Alpha", "hello") });

    await resolveSkills({
      directories: [dir("alpha", "v1")],
      plugin: PLUGIN,
      api,
      // Same version_id, but the marker's ids differ, so the bytes differ.
      existing: syncedTree(markerFor("v1", { ...META, skillsDataSourceId: "old-ds" })),
      pluginsDir: "plugins",
      meta: META,
    });

    expect(api.fetched).toEqual(["dir-alpha"]);
  });

  // A matching marker isn't enough on its own: if someone hand-deleted the
  // skill body, retaining would leave the dir broken forever.
  test("re-downloads when the marker matches but SKILL.md is missing", async () => {
    const api = fakeApi({ "dir-alpha": archiveFor("Alpha", "restored") });

    await resolveSkills({
      directories: [dir("alpha", "v1")],
      plugin: PLUGIN,
      api,
      // A genuinely matching marker: the missing SKILL.md is the only reason
      // this must not be retained.
      existing: new Map([[MARKER, gitBlobSha(markerFor("v1"))]]),
      pluginsDir: "plugins",
      meta: META,
    });

    expect(api.fetched).toEqual(["dir-alpha"]);
  });

  test("deduplicates slugs when two skills kebab-case to the same name", async () => {
    const api = fakeApi({
      "dir-notes": archiveFor("Notes", "a"),
      "dir-notes-2": archiveFor("Notes", "b"),
    });
    const skills = await resolveSkills({
      directories: [
        { ...dir("notes", "v1"), id: "dir-notes" },
        { ...dir("notes", "v1"), id: "dir-notes-2" },
      ],
      plugin: PLUGIN,
      api,
      existing: new Map(),
      pluginsDir: "plugins",
      meta: META,
    });

    expect(skills.map((s) => s.slug)).toEqual(["notes", "notes-2"]);
  });
});
