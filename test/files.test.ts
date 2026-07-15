import { describe, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { pickSkillZip, isSafeEntryPath, unzipSkillArchive } from "../src/files.ts";
import type { NotionFileRef } from "../src/notion/types.ts";

const ref = (name: string): NotionFileRef => ({ name, url: `https://x/${name}` });

describe("pickSkillZip", () => {
  test("no files -> nothing, no warning", () => {
    expect(pickSkillZip(undefined)).toEqual({ zip: null });
    expect(pickSkillZip([])).toEqual({ zip: null });
  });

  test("single zip -> picked, no warning", () => {
    const r = pickSkillZip([ref("skill.zip")]);
    expect(r.zip?.name).toBe("skill.zip");
    expect(r.warning).toBeUndefined();
  });

  test("case-insensitive .ZIP extension", () => {
    expect(pickSkillZip([ref("Skill.ZIP")]).zip?.name).toBe("Skill.ZIP");
  });

  test("files but no zip -> warns, nothing", () => {
    const r = pickSkillZip([ref("notes.md")]);
    expect(r.zip).toBeNull();
    expect(r.warning).toContain("no .zip");
  });

  test("multiple zips -> warns, nothing", () => {
    const r = pickSkillZip([ref("a.zip"), ref("b.zip")]);
    expect(r.zip).toBeNull();
    expect(r.warning).toContain("exactly one");
  });

  test("one zip + loose files -> picks zip, warns about the rest", () => {
    const r = pickSkillZip([ref("skill.zip"), ref("stray.txt")]);
    expect(r.zip?.name).toBe("skill.zip");
    expect(r.warning).toContain("non-zip");
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
});
