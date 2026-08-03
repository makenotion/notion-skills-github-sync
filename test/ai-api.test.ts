import { describe, expect, test } from "bun:test";
import { parsePlugin, parseArchive } from "../src/notion/ai-api.ts";

describe("parsePlugin", () => {
  test("parses a plugin with camelCase skillDirectories", () => {
    const p = parsePlugin({
      name: "writing-tools",
      description: "Tools that help you write.",
      skillDirectories: [
        { id: "id-1", name: "email-draft" },
        { id: "id-2", name: "meeting-notes" },
      ],
    });
    expect(p).toEqual({
      name: "writing-tools",
      description: "Tools that help you write.",
      skillDirectories: [
        { id: "id-1", name: "email-draft" },
        { id: "id-2", name: "meeting-notes" },
      ],
    });
  });

  test("tolerates snake_case skill_directories and slug/id fallbacks", () => {
    const p = parsePlugin({
      slug: "finance",
      skill_directories: [{ id: "id-9" }],
    });
    expect(p.name).toBe("finance");
    expect(p.description).toBe("");
    // With no explicit name, the directory falls back to its id.
    expect(p.skillDirectories).toEqual([{ id: "id-9", name: "id-9" }]);
  });

  test("drops directory entries without an id", () => {
    const p = parsePlugin({
      name: "x",
      skillDirectories: [{ name: "no-id" }, { id: "keep", name: "keep" }],
    });
    expect(p.skillDirectories).toEqual([{ id: "keep", name: "keep" }]);
  });

  test("handles missing skill directories", () => {
    const p = parsePlugin({ name: "empty" });
    expect(p.skillDirectories).toEqual([]);
  });
});

describe("parseArchive", () => {
  test("parses id, url, version_id", () => {
    const a = parseArchive({ id: "id-1", url: "https://s3/x", version_id: "sha:abc" });
    expect(a).toEqual({ id: "id-1", url: "https://s3/x", versionId: "sha:abc" });
  });

  test("tolerates camelCase versionId and signed_url alias", () => {
    const a = parseArchive({ id: "id-1", signed_url: "https://s3/y", versionId: "v2" });
    expect(a.url).toBe("https://s3/y");
    expect(a.versionId).toBe("v2");
  });
});
