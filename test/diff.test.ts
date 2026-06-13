import { describe, expect, test } from "bun:test";
import { gitBlobSha, computeChanges, hasChanges } from "../src/diff.ts";

describe("gitBlobSha", () => {
  // Matches `printf '...' | git hash-object --stdin`.
  test("matches real git blob ids", () => {
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("computeChanges", () => {
  test("classifies create vs unchanged and filters deletes to existing", () => {
    const existing = new Map<string, string>([
      ["a.txt", gitBlobSha("A")],
      ["b.txt", gitBlobSha("OLD")],
      ["gone.txt", gitBlobSha("x")],
    ]);
    const changes = computeChanges({
      existing,
      desired: { "a.txt": "A", "b.txt": "NEW", "c.txt": "C" },
      deletePaths: ["gone.txt", "never-existed.txt"],
    });
    expect(changes.unchanged).toBe(1); // a.txt
    expect(changes.create.map((c) => c.path).sort()).toEqual(["b.txt", "c.txt"]);
    expect(changes.delete).toEqual(["gone.txt"]); // never-existed filtered out
    expect(hasChanges(changes)).toBe(true);
  });

  test("idempotent: identical desired set yields no changes", () => {
    const existing = new Map<string, string>([["a.txt", gitBlobSha("A")]]);
    const changes = computeChanges({ existing, desired: { "a.txt": "A" }, deletePaths: [] });
    expect(hasChanges(changes)).toBe(false);
    expect(changes.unchanged).toBe(1);
  });
});
