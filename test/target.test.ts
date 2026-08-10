import { describe, expect, test } from "bun:test";
import { computeChanges, gitBlobSha, hasChanges } from "../src/target/target.ts";
import { MemoryTarget } from "../src/target/memory.ts";

describe("gitBlobSha", () => {
  // Matches `printf '...' | git hash-object --stdin`.
  test("matches real git blob ids", () => {
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  test("text and the same bytes hash identically", () => {
    expect(gitBlobSha(new TextEncoder().encode("hello\n"))).toBe(gitBlobSha("hello\n"));
  });
});

describe("computeChanges", () => {
  const contentId = gitBlobSha;

  test("classifies writes vs unchanged and filters deletes to what exists", () => {
    const existing = new Map<string, string>([
      ["a.txt", gitBlobSha("A")],
      ["b.txt", gitBlobSha("OLD")],
      ["gone.txt", gitBlobSha("x")],
    ]);
    const changes = computeChanges({
      existing,
      desired: { "a.txt": "A", "b.txt": "NEW", "c.txt": "C" },
      deletePaths: ["gone.txt", "never-existed.txt"],
      contentId,
    });
    expect(changes.unchanged).toBe(1); // a.txt
    expect(changes.write.map((c) => c.path).sort()).toEqual(["b.txt", "c.txt"]);
    expect(changes.delete).toEqual(["gone.txt"]); // never-existed filtered out
    expect(hasChanges(changes)).toBe(true);
  });

  test("idempotent: an identical desired set yields no changes", () => {
    const existing = new Map<string, string>([["a.txt", gitBlobSha("A")]]);
    const changes = computeChanges({
      existing,
      desired: { "a.txt": "A" },
      deletePaths: [],
      contentId,
    });
    expect(hasChanges(changes)).toBe(false);
    expect(changes.unchanged).toBe(1);
  });
});

// The in-memory target is the readable reference implementation of the
// interface, so its own round-trip is worth pinning down.
describe("MemoryTarget", () => {
  test("round-trips writes, deletes, and records one commit per apply", async () => {
    const target = new MemoryTarget({ "keep.txt": "keep", "drop.txt": "drop" });
    const before = await target.readState();
    expect([...before.files.keys()].sort()).toEqual(["drop.txt", "keep.txt"]);
    expect(before.files.get("keep.txt")).toBe(gitBlobSha("keep"));

    await target.apply(
      { write: [{ path: "new.bin", content: new Uint8Array([1, 2, 3]) }], delete: ["drop.txt"], unchanged: 1 },
      { message: "first" },
    );

    expect(target.paths()).toEqual(["keep.txt", "new.bin"]);
    expect(target.bytes("new.bin")).toEqual(new Uint8Array([1, 2, 3]));
    expect(target.commits).toEqual([
      { message: "first", written: ["new.bin"], deleted: ["drop.txt"] },
    ]);
    expect(await target.readText("missing.txt")).toBeNull();
  });
});
