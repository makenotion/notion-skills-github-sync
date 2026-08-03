import { describe, expect, test } from "bun:test";
import {
  buildPluginJson,
  marketplaceListing,
  mergeMarketplace,
  type Marketplace,
  type PluginMeta,
} from "../src/convert.ts";

const meta = (over: Partial<PluginMeta> = {}): PluginMeta => ({
  name: "writing-tools",
  version: "1.0.0",
  description: "Tools that help you write.",
  author: { name: "Test Author" },
  ...over,
});

describe("buildPluginJson", () => {
  test("renders the plugin metadata as pretty JSON with a trailing newline", () => {
    const out = buildPluginJson(meta());
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({
      name: "writing-tools",
      version: "1.0.0",
      description: "Tools that help you write.",
      author: { name: "Test Author" },
    });
  });
});

describe("marketplaceListing", () => {
  test("builds a client-neutral listing pointing at the plugin dir", () => {
    expect(
      marketplaceListing({ name: "writing-tools", description: "d" }, "plugins"),
    ).toEqual({
      name: "writing-tools",
      source: "./plugins/writing-tools",
      description: "d",
    });
  });
});

describe("mergeMarketplace", () => {
  const existing: Marketplace = {
    name: "test-skills",
    owner: { name: "Test Team" },
    plugins: [
      { name: "hello-world", source: "./plugins/hello-world", description: "hi" },
      { name: "old-skill", source: "./plugins/old-skill", description: "stale" },
    ],
  };

  test("preserves non-managed, adds managed, prunes removed", () => {
    const desired = [
      { name: "message-review", source: "./plugins/message-review", description: "d" },
    ];
    const controlled = new Set(["message-review", "old-skill"]); // old-skill was managed, now gone
    const merged = mergeMarketplace(existing, desired, controlled);
    const names = merged.plugins.map((p) => p.name);
    expect(names).toContain("hello-world"); // preserved
    expect(names).toContain("message-review"); // added
    expect(names).not.toContain("old-skill"); // pruned
  });

  test("managed entries are sorted for determinism", () => {
    const desired = [
      { name: "zebra", source: "./plugins/zebra", description: "z" },
      { name: "apple", source: "./plugins/apple", description: "a" },
    ];
    const merged = mergeMarketplace(existing, desired, new Set(["zebra", "apple"]));
    const managed = merged.plugins.filter((p) => p.name === "apple" || p.name === "zebra");
    expect(managed.map((p) => p.name)).toEqual(["apple", "zebra"]);
  });
});
