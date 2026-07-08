import { describe, expect, test } from "bun:test";
import { extractPluginNames } from "../src/notion/ntn-adapter.ts";
import { resolvePluginSlugs } from "../src/sync.ts";

describe("extractPluginNames", () => {
  test("reads a single-select value", () => {
    const prop = { type: "select", select: { name: "Writing Tools" } };
    expect(extractPluginNames(prop)).toEqual(["Writing Tools"]);
  });

  test("empty single-select yields no plugins", () => {
    expect(extractPluginNames({ type: "select", select: null })).toEqual([]);
    expect(extractPluginNames({ type: "select", select: { name: "  " } })).toEqual([]);
  });

  test("reads all multi-select values in order", () => {
    const prop = {
      type: "multi_select",
      multi_select: [{ name: "Writing Tools" }, { name: "Research" }],
    };
    expect(extractPluginNames(prop)).toEqual(["Writing Tools", "Research"]);
  });

  test("multi-select drops blanks and duplicates, preserving order", () => {
    const prop = {
      type: "multi_select",
      multi_select: [{ name: "Research" }, { name: "" }, { name: "Research" }, { name: "Writing" }],
    };
    expect(extractPluginNames(prop)).toEqual(["Research", "Writing"]);
  });

  test("empty multi-select yields no plugins", () => {
    expect(extractPluginNames({ type: "multi_select", multi_select: [] })).toEqual([]);
  });

  test("unset or unknown property types yield no plugins", () => {
    expect(extractPluginNames(undefined)).toEqual([]);
    expect(extractPluginNames({ type: "rich_text" })).toEqual([]);
  });
});

describe("resolvePluginSlugs", () => {
  test("defaults to 'skills' when unset or empty", () => {
    expect(resolvePluginSlugs(undefined)).toEqual(["skills"]);
    expect(resolvePluginSlugs([])).toEqual(["skills"]);
  });

  test("slugifies a single plugin", () => {
    expect(resolvePluginSlugs(["Writing Tools"])).toEqual(["writing-tools"]);
  });

  test("slugifies and dedupes multiple plugins", () => {
    expect(resolvePluginSlugs(["Writing Tools", "Research", "Writing Tools"])).toEqual([
      "writing-tools",
      "research",
    ]);
  });

  test("drops values that slugify to empty; falls back to 'skills' when all empty", () => {
    expect(resolvePluginSlugs(["!!!", "  "])).toEqual(["skills"]);
    expect(resolvePluginSlugs(["!!!", "Research"])).toEqual(["research"]);
  });
});
