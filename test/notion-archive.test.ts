import { describe, expect, test } from "bun:test";
import { gzipSync, zipSync, strToU8 } from "fflate";
import {
  extractPluginArchive,
  extractSkillArchive,
  isSafeEntryPath,
  stripSingleTopLevelDir,
  unzipSkillArchive,
  zipSkillFiles,
} from "../src/notion/archive.ts";
import { makeTar, type TarInput } from "./tar-helper.ts";

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

// Stand in for what a signed archive URL hands back: a gzipped tar. Historically
// this wrapped a single skill in a page-title directory; now GET
// /v1/ai/plugins/:id wraps a whole plugin (plugin.json + skills/<dir>/…).
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

describe("extractSkillArchive", () => {
  test("strips the page-title wrapper directory", () => {
    const { files } = extractSkillArchive(
      targz([
        { name: "Meeting Notes/SKILL.md", data: "---\nname: meeting-notes\n---\n\nBody" },
        { name: "Meeting Notes/checklist.md", data: "- [ ] item" },
      ]),
    );
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "checklist.md"]);
    expect(text(files["SKILL.md"])).toContain("name: meeting-notes");
  });

  test("leaves paths alone when entries don't share one root", () => {
    const { files } = extractSkillArchive(
      targz([
        { name: "a/SKILL.md", data: "x" },
        { name: "b/other.md", data: "y" },
      ]),
    );
    expect(Object.keys(files).sort()).toEqual(["a/SKILL.md", "b/other.md"]);
  });

  test("keeps binary attachments byte-exact", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const { files } = extractSkillArchive(
      targz([
        { name: "Skill/SKILL.md", data: "body" },
        { name: "Skill/banner.png", data: png },
      ]),
    );
    expect([...files["banner.png"]!]).toEqual([...png]);
  });

  test("drops macOS cruft", () => {
    const { files } = extractSkillArchive(
      targz([
        { name: "Skill/SKILL.md", data: "body" },
        { name: "Skill/.DS_Store", data: "junk" },
        { name: "Skill/__MACOSX/x", data: "junk" },
      ]),
    );
    expect(Object.keys(files)).toEqual(["SKILL.md"]);
  });

  test("reports unsafe entries instead of writing them", () => {
    const { files, skipped } = extractSkillArchive(
      targz([
        { name: "Skill/SKILL.md", data: "body" },
        { name: "escape", paxPath: "Skill/../../../etc/passwd", data: "bad" },
      ]),
    );
    expect(Object.keys(files)).toEqual(["SKILL.md"]);
    expect(skipped).toHaveLength(1);
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
      const { files, expandedZip } = extractSkillArchive(
        targz([
          { name: "Meeting Notes/SKILL.md", data: "body" },
          { name: "Meeting Notes/meeting-notes.zip", data: zip },
        ]),
      );

      expect(expandedZip).toBe("meeting-notes.zip");
      expect(Object.keys(files).sort()).toEqual([
        "SKILL.md",
        "assets/banner.png",
        "scripts/run.py",
      ]);
      expect(text(files["scripts/run.py"])).toBe("print('hi')");
    });

    test("the API-rendered SKILL.md wins over one inside the zip", () => {
      const zip = zipSkillFiles({ "SKILL.md": "stale copy from the zip" });
      const { files } = extractSkillArchive(
        targz([
          { name: "Skill/SKILL.md", data: "rendered by Notion" },
          { name: "Skill/extras.zip", data: zip },
        ]),
      );
      expect(text(files["SKILL.md"])).toBe("rendered by Notion");
    });

    test("leaves things alone when there isn't exactly one zip", () => {
      const zip = zipSkillFiles({ "a.txt": "a" });
      const two = extractSkillArchive(
        targz([
          { name: "Skill/SKILL.md", data: "body" },
          { name: "Skill/one.zip", data: zip },
          { name: "Skill/two.zip", data: zip },
        ]),
      );
      expect(two.expandedZip).toBeUndefined();
      expect(Object.keys(two.files).sort()).toEqual(["SKILL.md", "one.zip", "two.zip"]);

      const none = extractSkillArchive(targz([{ name: "Skill/SKILL.md", data: "body" }]));
      expect(none.expandedZip).toBeUndefined();
      expect(Object.keys(none.files)).toEqual(["SKILL.md"]);
    });
  });
});

describe("extractPluginArchive", () => {
  test("splits a whole-plugin archive into per-skill buckets, keeping extras out", () => {
    const { skills, extras } = extractPluginArchive(
      targz([
        { name: "Finance/plugin.json", data: '{ "name": "finance" }' },
        { name: "Finance/mcp.json", data: "{}" },
        { name: "Finance/skills/expense-review/SKILL.md", data: "---\nname: expense-review\n---\n" },
        { name: "Finance/skills/expense-review/references/policy.md", data: "# Policy" },
        { name: "Finance/skills/budget-close/SKILL.md", data: "---\nname: budget-close\n---\n" },
      ]),
    );

    expect(Object.keys(skills).sort()).toEqual(["budget-close", "expense-review"]);
    expect(Object.keys(skills["expense-review"]!.files).sort()).toEqual([
      "SKILL.md",
      "references/policy.md",
    ]);
    // plugin.json / mcp.json live at the plugin root, never inside a skill.
    expect(Object.keys(extras).sort()).toEqual(["mcp.json", "plugin.json"]);
  });

  test("expands a lone attachment zip inside a single skill, root SKILL.md winning", () => {
    const inner = zipSync({
      "scripts/run.py": strToU8("print('hi')\n"),
      "SKILL.md": strToU8("# from the zip — ignored\n"),
    });
    const { skills } = extractPluginArchive(
      targz([
        { name: "Team/skills/deploy/SKILL.md", data: "---\nname: deploy\n---\n\nreal body" },
        { name: "Team/skills/deploy/files.zip", data: inner },
      ]),
    );

    const deploy = skills["deploy"]!;
    expect(Object.keys(deploy.files).sort()).toEqual(["SKILL.md", "scripts/run.py"]);
    expect(deploy.expandedZip).toBe("files.zip");
    expect(text(deploy.files["SKILL.md"])).toContain("real body");
  });

  test("reports unsafe entries and drops them from every bucket", () => {
    const { skills, skipped } = extractPluginArchive(
      targz([
        { name: "Team/skills/ok/SKILL.md", data: "body" },
        { name: "Team/skills/ok/../../escape.md", data: "nope", paxPath: "Team/skills/ok/../../escape.md" },
      ]),
    );

    expect(Object.keys(skills)).toEqual(["ok"]);
    expect(skipped.length).toBeGreaterThan(0);
    expect(Object.keys(skills["ok"]!.files)).toEqual(["SKILL.md"]);
  });

  test("handles a plugin with no wrapping directory", () => {
    const { skills, extras } = extractPluginArchive(
      targz([
        { name: "plugin.json", data: '{ "name": "solo" }' },
        { name: "skills/only/SKILL.md", data: "body" },
      ]),
    );

    expect(Object.keys(skills)).toEqual(["only"]);
    expect(Object.keys(extras)).toEqual(["plugin.json"]);
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
