import { describe, expect, test } from "bun:test";
import { gzipSync, zipSync, strToU8 } from "fflate";
import {
  extractPluginArchive,
  isSafeEntryPath,
  stripSingleTopLevelDir,
  unzipSkillArchive,
  zipSkillFiles,
} from "../src/notion/archive.ts";
import { makeTar, type TarInput } from "./tar-helper.ts";

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

// Stand in for what a signed archive URL hands back: the gzipped tar that GET
// /v1/ai/plugins/:id points at — a whole plugin, wrapped in one directory named
// after it (plugin.json at that root, every skill under skills/<dir>/).
const targz = (entries: TarInput[]) => gzipSync(makeTar(entries));

describe("isSafeEntryPath", () => {
  test("accepts normal relative paths", () => {
    expect(isSafeEntryPath("scripts/run.py")).toBe(true);
    expect(isSafeEntryPath("references/notes.md")).toBe(true);
  });
  test("rejects empty, absolute, and traversal", () => {
    expect(isSafeEntryPath("")).toBe(false);
    expect(isSafeEntryPath("/etc/passwd")).toBe(false);
    expect(isSafeEntryPath("../escape.txt")).toBe(false);
    expect(isSafeEntryPath("a/../../b")).toBe(false);
    expect(isSafeEntryPath("..\\win")).toBe(false);
  });
});

describe("extractPluginArchive", () => {
  test("maps the skills subtree onto plugin-dir-relative paths, dropping root entries", () => {
    const { files, skills, ignored } = extractPluginArchive(
      targz([
        { name: "Finance/plugin.json", data: '{ "name": "finance" }' },
        { name: "Finance/mcp.json", data: "{}" },
        { name: "Finance/skills/expense-review/SKILL.md", data: "---\nname: expense-review\n---\n" },
        { name: "Finance/skills/expense-review/references/policy.md", data: "# Policy" },
        { name: "Finance/skills/budget-close/SKILL.md", data: "---\nname: budget-close\n---\n" },
      ]),
    );

    // The wrapping directory is stripped; everything else is already the layout
    // the published plugin directory wants, so it passes straight through.
    expect(Object.keys(files).sort()).toEqual([
      "skills/budget-close/SKILL.md",
      "skills/expense-review/SKILL.md",
      "skills/expense-review/references/policy.md",
    ]);
    // Sorted, so the marker's skill list is stable across runs.
    expect(skills).toEqual(["budget-close", "expense-review"]);
    // The Agent Plugins manifest would collide with our per-client manifests.
    expect(ignored.sort()).toEqual(["mcp.json", "plugin.json"]);
  });

  test("handles a plugin with no wrapping directory", () => {
    const { files, skills } = extractPluginArchive(
      targz([
        { name: "plugin.json", data: '{ "name": "solo" }' },
        { name: "skills/only/SKILL.md", data: "body" },
      ]),
    );

    expect(skills).toEqual(["only"]);
    expect(Object.keys(files)).toEqual(["skills/only/SKILL.md"]);
  });

  // `skills/` sits at the plugin root, so it must never be mistaken for the
  // wrapping directory — an unwrapped archive would otherwise lose its layout.
  test("does not mistake a bare skills/ root for the wrapper", () => {
    const { files, skills } = extractPluginArchive(
      targz([
        { name: "skills/a/SKILL.md", data: "x" },
        { name: "skills/b/SKILL.md", data: "y" },
      ]),
    );
    expect(skills).toEqual(["a", "b"]);
    expect(Object.keys(files).sort()).toEqual(["skills/a/SKILL.md", "skills/b/SKILL.md"]);
  });

  test("keeps binary attachments byte-exact", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const { files } = extractPluginArchive(
      targz([
        { name: "P/skills/s/SKILL.md", data: "body" },
        { name: "P/skills/s/banner.png", data: png },
      ]),
    );
    expect([...files["skills/s/banner.png"]!]).toEqual([...png]);
  });

  test("drops macOS cruft", () => {
    const { files } = extractPluginArchive(
      targz([
        { name: "P/skills/s/SKILL.md", data: "body" },
        { name: "P/skills/s/.DS_Store", data: "junk" },
        { name: "P/skills/s/__MACOSX/x", data: "junk" },
      ]),
    );
    expect(Object.keys(files)).toEqual(["skills/s/SKILL.md"]);
  });

  test("reports unsafe entries instead of writing them", () => {
    const { files, skipped } = extractPluginArchive(
      targz([
        { name: "P/skills/ok/SKILL.md", data: "body" },
        { name: "escape", paxPath: "P/skills/ok/../../../etc/passwd", data: "bad" },
      ]),
    );
    expect(Object.keys(files)).toEqual(["skills/ok/SKILL.md"]);
    expect(skipped).toHaveLength(1);
  });

  // A skill dir is only a skill if it has the SKILL.md the API renders. Dropping
  // the fragment keeps `skills` equal to what a synced repo will contain, which
  // is what the marker's heal-on-divergence check depends on.
  test("drops a skill directory that has no SKILL.md", () => {
    const { files, skills, invalid } = extractPluginArchive(
      targz([
        { name: "P/skills/good/SKILL.md", data: "body" },
        { name: "P/skills/orphan/notes.md", data: "no SKILL.md here" },
      ]),
    );
    expect(skills).toEqual(["good"]);
    expect(invalid).toEqual(["orphan"]);
    expect(Object.keys(files)).toEqual(["skills/good/SKILL.md"]);
  });

  // Skills that need real structure store it as one zip on the Notion Files
  // property. The API archives that zip verbatim, so we expand it here or the
  // plugin would ship an opaque zip instead of usable files.
  describe("attachment zip expansion", () => {
    test("expands a lone zip in place, preserving nested folders", () => {
      const zip = zipSkillFiles({
        "scripts/run.py": "print('hi')",
        "assets/banner.png": new Uint8Array([1, 2, 3]),
      });
      const { files, expandedZips } = extractPluginArchive(
        targz([
          { name: "P/skills/meeting-notes/SKILL.md", data: "body" },
          { name: "P/skills/meeting-notes/meeting-notes.zip", data: zip },
        ]),
      );

      expect(expandedZips).toEqual(["meeting-notes/meeting-notes.zip"]);
      expect(Object.keys(files).sort()).toEqual([
        "skills/meeting-notes/SKILL.md",
        "skills/meeting-notes/assets/banner.png",
        "skills/meeting-notes/scripts/run.py",
      ]);
      expect(text(files["skills/meeting-notes/scripts/run.py"])).toBe("print('hi')");
    });

    test("expands each skill's zip independently", () => {
      const a = zipSkillFiles({ "a.txt": "a" });
      const b = zipSkillFiles({ "b.txt": "b" });
      const { files, expandedZips } = extractPluginArchive(
        targz([
          { name: "P/skills/one/SKILL.md", data: "body" },
          { name: "P/skills/one/files.zip", data: a },
          { name: "P/skills/two/SKILL.md", data: "body" },
          { name: "P/skills/two/files.zip", data: b },
        ]),
      );
      expect(expandedZips.sort()).toEqual(["one/files.zip", "two/files.zip"]);
      expect(text(files["skills/one/a.txt"])).toBe("a");
      expect(text(files["skills/two/b.txt"])).toBe("b");
    });

    test("the API-rendered SKILL.md wins over one inside the zip", () => {
      const zip = zipSkillFiles({ "SKILL.md": "stale copy from the zip" });
      const { files } = extractPluginArchive(
        targz([
          { name: "P/skills/s/SKILL.md", data: "rendered by Notion" },
          { name: "P/skills/s/extras.zip", data: zip },
        ]),
      );
      expect(text(files["skills/s/SKILL.md"])).toBe("rendered by Notion");
    });

    test("leaves things alone when there isn't exactly one zip", () => {
      const zip = zipSkillFiles({ "a.txt": "a" });
      const two = extractPluginArchive(
        targz([
          { name: "P/skills/s/SKILL.md", data: "body" },
          { name: "P/skills/s/one.zip", data: zip },
          { name: "P/skills/s/two.zip", data: zip },
        ]),
      );
      expect(two.expandedZips).toEqual([]);
      expect(Object.keys(two.files).sort()).toEqual([
        "skills/s/SKILL.md",
        "skills/s/one.zip",
        "skills/s/two.zip",
      ]);

      const none = extractPluginArchive(targz([{ name: "P/skills/s/SKILL.md", data: "body" }]));
      expect(none.expandedZips).toEqual([]);
      expect(Object.keys(none.files)).toEqual(["skills/s/SKILL.md"]);
    });
  });
});

describe("unzipSkillArchive", () => {
  test("unpacks files, skips dir entries and macOS cruft", () => {
    const zip = zipSync({
      "SKILL.md": strToU8("placeholder"),
      "scripts/hello.py": strToU8("print('hi')"),
      "references/notes.md": strToU8("# ref"),
      "__MACOSX/._SKILL.md": strToU8("junk"),
      ".DS_Store": strToU8("junk"),
    });
    const { files, skipped } = unzipSkillArchive(zip);
    const names = Object.keys(files).sort();
    expect(names).toEqual(["SKILL.md", "references/notes.md", "scripts/hello.py"]);
    expect(skipped).toEqual([]);
    expect(text(files["scripts/hello.py"])).toBe("print('hi')");
  });

  test("preserves binary content byte-for-byte", () => {
    const bin = new Uint8Array([0, 1, 2, 255, 254, 128, 0]);
    const zip = zipSync({ "assets/blob.bin": bin });
    const { files } = unzipSkillArchive(zip);
    expect([...files["assets/blob.bin"]!]).toEqual([...bin]);
  });
});

describe("zipSkillFiles", () => {
  test("round-trips through unzipSkillArchive (text and binary)", () => {
    const bin = new Uint8Array([7, 0, 255, 42]);
    const zip = zipSkillFiles({
      "templates/meeting-notes.md": "# Template\n",
      "assets/icon.bin": bin,
    });
    const { files, skipped } = unzipSkillArchive(zip);
    expect(skipped).toEqual([]);
    expect(text(files["templates/meeting-notes.md"])).toBe("# Template\n");
    expect([...files["assets/icon.bin"]!]).toEqual([...bin]);
  });
});

// Ported from main (e89eec7): some archivers wrap a skill's contents in one
// extra top-level folder. Left alone that produces a doubly-nested skill dir.
describe("stripSingleTopLevelDir", () => {
  const u8 = (s: string) => strToU8(s);

  test("strips a wrapper that contains a SKILL.md", () => {
    const out = stripSingleTopLevelDir({
      "my-skill/SKILL.md": u8("a"),
      "my-skill/scripts/run.py": u8("b"),
    });
    expect(Object.keys(out).sort()).toEqual(["SKILL.md", "scripts/run.py"]);
  });

  test("strips a wrapper whose name matches the skill slug", () => {
    const out = stripSingleTopLevelDir({ "my-skill/scripts/run.py": u8("b") }, "my-skill");
    expect(Object.keys(out)).toEqual(["scripts/run.py"]);
  });

  test("matches the slug case/space-insensitively", () => {
    const out = stripSingleTopLevelDir({ "My Skill/scripts/run.py": u8("b") }, "my-skill");
    expect(Object.keys(out)).toEqual(["scripts/run.py"]);
  });

  test("does not strip a lone folder that is neither named after the skill nor holds a SKILL.md", () => {
    const input = { "assets/blob.bin": u8("x"), "assets/more.bin": u8("y") };
    expect(stripSingleTopLevelDir(input, "meeting-notes")).toBe(input);
  });

  test("leaves root-level files untouched", () => {
    const input = { "SKILL.md": u8("a"), "scripts/run.py": u8("b") };
    expect(stripSingleTopLevelDir(input)).toBe(input);
  });

  test("does not strip when a file sits at the root alongside a dir", () => {
    const input = { "SKILL.md": u8("a"), "wrapper/run.py": u8("b") };
    expect(stripSingleTopLevelDir(input)).toBe(input);
  });

  test("does not strip when two top-level dirs are present", () => {
    const input = { "a/one.txt": u8("1"), "b/two.txt": u8("2") };
    expect(stripSingleTopLevelDir(input)).toBe(input);
  });

  test("empty map is returned as-is", () => {
    const input = {};
    expect(stripSingleTopLevelDir(input)).toBe(input);
  });
});

describe("unzipSkillArchive wrapper unwrapping", () => {
  test("unwraps a single extra top-level folder (Windows folder-zip)", () => {
    const zip = zipSync({
      "my-skill/": strToU8(""),
      "my-skill/SKILL.md": strToU8("placeholder"),
      "my-skill/scripts/hello.py": strToU8("print('hi')"),
      "my-skill/references/notes.md": strToU8("# ref"),
    });
    const { files } = unzipSkillArchive(zip);
    expect(Object.keys(files).sort()).toEqual([
      "SKILL.md",
      "references/notes.md",
      "scripts/hello.py",
    ]);
  });

  test("keeps root layout when there is no wrapping folder", () => {
    const zip = zipSync({
      "SKILL.md": strToU8("placeholder"),
      "scripts/hello.py": strToU8("print('hi')"),
    });
    const { files } = unzipSkillArchive(zip);
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "scripts/hello.py"]);
  });

  test("does not unwrap a lone content folder that isn't a skill wrapper", () => {
    const zip = zipSync({
      "references/a.md": strToU8("# a"),
      "references/b.md": strToU8("# b"),
    });
    const { files } = unzipSkillArchive(zip);
    expect(Object.keys(files).sort()).toEqual(["references/a.md", "references/b.md"]);
  });

  test("unwraps a wrapper named after the skill even without a SKILL.md", () => {
    const zip = zipSync({
      "meeting-notes/scripts/run.py": strToU8("print('hi')"),
      "meeting-notes/references/notes.md": strToU8("# ref"),
    });
    const { files } = unzipSkillArchive(zip, "meeting-notes");
    expect(Object.keys(files).sort()).toEqual(["references/notes.md", "scripts/run.py"]);
  });
});
