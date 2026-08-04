import { describe, expect, test } from "bun:test";
import { DEFAULT_PLUGIN_SLUG, resolvePluginTargets } from "../src/sync.ts";

const descriptions = new Map([
  ["Finance", "Skills for the Finance team"],
  ["EPD", "Skills for the EPD team"],
]);

describe("resolvePluginTargets", () => {
  test("slugifies each selected plugin and carries its Notion description", () => {
    expect(resolvePluginTargets(["Finance"], descriptions)).toEqual([
      ["finance", "Skills for the Finance team"],
    ]);
  });

  test("a skill tagged with several plugins is published into each", () => {
    expect(resolvePluginTargets(["Finance", "EPD"], descriptions)).toEqual([
      ["finance", "Skills for the Finance team"],
      ["epd", "Skills for the EPD team"],
    ]);
  });

  test("an untagged skill falls back to the catch-all plugin", () => {
    expect(resolvePluginTargets([], descriptions)).toEqual([[DEFAULT_PLUGIN_SLUG, undefined]]);
    expect(resolvePluginTargets(undefined, descriptions)).toEqual([
      [DEFAULT_PLUGIN_SLUG, undefined],
    ]);
  });

  test("options with no description resolve to undefined (skill's own is used)", () => {
    expect(resolvePluginTargets(["Sync Demo"], descriptions)).toEqual([["sync-demo", undefined]]);
  });

  test("options that slugify to the same directory are deduped, first wins", () => {
    expect(resolvePluginTargets(["Finance", "finance", "FINANCE"], descriptions)).toEqual([
      ["finance", "Skills for the Finance team"],
    ]);
  });

  test("a name that slugifies to nothing falls back rather than making an empty dir", () => {
    expect(resolvePluginTargets(["///"], descriptions)).toEqual([[DEFAULT_PLUGIN_SLUG, undefined]]);
  });
});
