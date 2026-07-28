import { describe, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import {
  pickSkillZip,
  isSafeEntryPath,
  unzipSkillArchive,
  zipSkillFiles,
  stripSingleTopLevelDir,
} from "../src/files.ts";
import type { NotionFileRef } from "../src/notion/types.ts";

const ref = (name: string): NotionFileRef => ({ name, url: `https://x/${name}` });

describe("pickSkillZip", () => {
  test("no files -> null (a valid, ordinary state)", () => {
    expect(pickSkillZip(undefined)).toBeNull();
    expect(pickSkillZip([])).toBeNull();
  });

  test("single zip -> picked", () => {
    expect(pickSkillZip([ref("skill.zip")])?.name).toBe("skill.zip");
  });

  test("case-insensitive .ZIP extension", () => {
    expect(pickSkillZip([ref("Skill.ZIP")])?.name).toBe("Skill.ZIP");
  });

  test("files but no zip -> null", () => {
    expect(pickSkillZip([ref("notes.md")])).toBeNull();
  });

  test("multiple zips -> ambiguous, null", () => {
    expect(pickSkillZip([ref("a.zip"), ref("b.zip")])).toBeNull();
  });

  test("one zip + loose files -> still picks the zip", () => {
    expect(pickSkillZip([ref("skill.zip"), ref("stray.txt")])?.name).toBe("skill.zip");
  });
});

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
    expect(new TextDecoder().decode(files["scripts/hello.py"]!)).toBe("print('hi')");
  });

  test("preserves binary content byte-for-byte", () => {
    const bin = new Uint8Array([0, 1, 2, 255, 254, 128, 0]);
    const zip = zipSync({ "assets/blob.bin": bin });
    const { files } = unzipSkillArchive(zip);
    expect([...files["assets/blob.bin"]!]).toEqual([...bin]);
  });

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

  test("does not unwrap when multiple top-level dirs exist", () => {
    const zip = zipSync({
      "scripts/hello.py": strToU8("print('hi')"),
      "references/notes.md": strToU8("# ref"),
    });
    const { files } = unzipSkillArchive(zip);
    expect(Object.keys(files).sort()).toEqual(["references/notes.md", "scripts/hello.py"]);
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
    const out = stripSingleTopLevelDir(
      { "my-skill/scripts/run.py": u8("b") },
      "my-skill",
    );
    expect(Object.keys(out)).toEqual(["scripts/run.py"]);
  });

  test("matches the slug case/space-insensitively via slugify", () => {
    const out = stripSingleTopLevelDir(
      { "My Skill/scripts/run.py": u8("b") },
      "my-skill",
    );
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

describe("zipSkillFiles", () => {
  test("round-trips through unzipSkillArchive (text and binary)", () => {
    const bin = new Uint8Array([7, 0, 255, 42]);
    const zip = zipSkillFiles({
      "templates/meeting-notes.md": "# Template\n",
      "assets/icon.bin": bin,
    });
    const { files, skipped } = unzipSkillArchive(zip);
    expect(skipped).toEqual([]);
    expect(new TextDecoder().decode(files["templates/meeting-notes.md"]!)).toBe("# Template\n");
    expect([...files["assets/icon.bin"]!]).toEqual([...bin]);
  });
});
