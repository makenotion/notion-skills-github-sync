import { describe, expect, test } from "bun:test";
import { untar } from "../src/notion/untar.ts";
import { makeTar } from "./tar-helper.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("untar", () => {
  test("reads plain ustar entries", () => {
    const entries = untar(
      makeTar([
        { name: "Meeting Notes/SKILL.md", data: "# Notes" },
        { name: "Meeting Notes/run.py", data: "print('hi')" },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual([
      "Meeting Notes/SKILL.md",
      "Meeting Notes/run.py",
    ]);
    expect(text(entries[0]!.data)).toBe("# Notes");
  });

  test("joins the ustar prefix field to the name", () => {
    const [entry] = untar(makeTar([{ prefix: "a/very/deep", name: "SKILL.md", data: "x" }]));
    expect(entry!.name).toBe("a/very/deep/SKILL.md");
  });

  // tar-stream (what the skills API uses) falls back to a PAX header for ANY
  // name that is non-ASCII or longer than 100 bytes — routine for Notion page
  // titles and for the API's 200-byte attachment names.
  test("prefers a PAX header's path over the truncated ustar name", () => {
    const longName = `Quarterly Planning/${"a".repeat(190)}.py`;
    const [entry] = untar(
      makeTar([{ name: "truncated.py", paxPath: longName, data: "payload" }]),
    );
    expect(entry!.name).toBe(longName);
    expect(text(entry!.data)).toBe("payload");
  });

  test("handles a non-ASCII PAX path", () => {
    const [entry] = untar(
      makeTar([{ name: "fallback", paxPath: "Café Résumé/SKILL.md", data: "é" }]),
    );
    expect(entry!.name).toBe("Café Résumé/SKILL.md");
  });

  test("a PAX header applies only to the entry that follows it", () => {
    const entries = untar(
      makeTar([
        { name: "short", paxPath: "Skill/long-name.md", data: "one" },
        { name: "Skill/plain.md", data: "two" },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(["Skill/long-name.md", "Skill/plain.md"]);
  });

  test("skips directory entries and global PAX headers", () => {
    const entries = untar(
      makeTar([
        { name: "Skill/", data: "", typeflag: "5" },
        { name: "pax_global_header", data: "20 comment=hello\n", typeflag: "g" },
        { name: "Skill/SKILL.md", data: "body" },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(["Skill/SKILL.md"]);
  });

  test("reads a GNU long name", () => {
    const longName = `Skill/${"b".repeat(150)}.md`;
    const entries = untar(
      makeTar([
        { name: "././@LongLink", data: `${longName}\0`, typeflag: "L" },
        { name: "truncated.md", data: "payload" },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual([longName]);
  });

  test("stops at the end-of-archive marker and ignores trailing junk", () => {
    const tar = makeTar([{ name: "Skill/SKILL.md", data: "body" }]);
    const withJunk = new Uint8Array(tar.length + 512);
    withJunk.set(tar);
    withJunk.fill(0x41, tar.length);
    expect(untar(withJunk).map((e) => e.name)).toEqual(["Skill/SKILL.md"]);
  });

  test("throws on an archive truncated mid-entry", () => {
    const tar = makeTar([{ name: "Skill/SKILL.md", data: "x".repeat(2000) }]);
    expect(() => untar(tar.slice(0, 1024))).toThrow(/[Tt]runcated/);
  });

  test("preserves binary content exactly", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 0]);
    const [entry] = untar(makeTar([{ name: "Skill/logo.png", data: bytes }]));
    expect([...entry!.data]).toEqual([...bytes]);
  });
});
