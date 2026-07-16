import { describe, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { pickSkillZip, isSafeEntryPath, unzipSkillArchive, zipSkillFiles } from "../src/files.ts";
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
