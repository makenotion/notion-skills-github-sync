import { describe, expect, test } from "bun:test";
import {
  buildOwnerOptions,
  hasOrgDefault,
  ownerOf,
  recommendedOwner,
  syncRepoDefaultOwner,
} from "../src/wizard/ownership.ts";

describe("recommendedOwner", () => {
  test("prefers the (first) org over the personal account", () => {
    expect(recommendedOwner("alice", ["future-fuel"])).toBe("future-fuel");
    expect(recommendedOwner("alice", ["future-fuel", "other-org"])).toBe("future-fuel");
  });

  test("falls back to the personal account with no orgs", () => {
    expect(recommendedOwner("alice", [])).toBe("alice");
  });

  test("ignores empty org entries", () => {
    expect(recommendedOwner("alice", ["", "future-fuel"])).toBe("future-fuel");
    expect(recommendedOwner("alice", ["", ""])).toBe("alice");
  });
});

describe("hasOrgDefault", () => {
  test("true only when a real org is present", () => {
    expect(hasOrgDefault(["future-fuel"])).toBe(true);
    expect(hasOrgDefault([])).toBe(false);
    expect(hasOrgDefault([""])).toBe(false);
  });
});

describe("buildOwnerOptions", () => {
  test("lists orgs first (recommended), personal account last", () => {
    const opts = buildOwnerOptions("alice", ["future-fuel", "other-org"]);
    expect(opts.map((o) => o.value)).toEqual(["future-fuel", "other-org", "alice"]);
    expect(opts[0]!.hint).toBe("organization (recommended)");
    expect(opts[1]!.hint).toBe("organization");
    expect(opts[2]!.hint).toBe("personal account");
  });

  test("personal account alone when no orgs", () => {
    const opts = buildOwnerOptions("alice", []);
    expect(opts.map((o) => o.value)).toEqual(["alice"]);
    expect(opts[0]!.hint).toBe("personal account");
  });

  test("drops empty org entries", () => {
    const opts = buildOwnerOptions("alice", ["", "future-fuel"]);
    expect(opts.map((o) => o.value)).toEqual(["future-fuel", "alice"]);
  });
});

describe("syncRepoDefaultOwner", () => {
  test("mirrors the skills repo owner when it's an org", () => {
    expect(syncRepoDefaultOwner("alice", ["future-fuel"], "future-fuel")).toBe("future-fuel");
  });

  test("does not mirror a personal skills-repo owner; still prefers the org", () => {
    expect(syncRepoDefaultOwner("alice", ["future-fuel"], "alice")).toBe("future-fuel");
  });

  test("falls back to recommended owner when no skills owner given", () => {
    expect(syncRepoDefaultOwner("alice", ["future-fuel"])).toBe("future-fuel");
    expect(syncRepoDefaultOwner("alice", [])).toBe("alice");
  });

  test("ignores an unknown skills owner (not one of the known orgs)", () => {
    expect(syncRepoDefaultOwner("alice", ["future-fuel"], "some-random")).toBe("future-fuel");
  });
});

describe("ownerOf", () => {
  test("parses the owner segment", () => {
    expect(ownerOf("future-fuel/notion-skills")).toBe("future-fuel");
    expect(ownerOf("alice/repo")).toBe("alice");
    expect(ownerOf("")).toBe("");
  });
});
