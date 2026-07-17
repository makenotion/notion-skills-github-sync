import { describe, expect, test } from "bun:test";
import {
  CLAUDE_MARKETPLACE_PATH,
  CLIENTS,
  CODEX_MARKETPLACE_PATH,
  CURSOR_MARKETPLACE_PATH,
  mergeMarketplace,
  pluginManifestPath,
  type ClientId,
  type MarketplaceSeed,
} from "../src/clients.ts";

const byId = (id: ClientId) => CLIENTS.find((c) => c.id === id)!;

const SEED: MarketplaceSeed = {
  name: "skills",
  owner: { name: "Skills Team" },
  displayName: "Skills",
  description: "Skills synced from Notion.",
};

describe("client registry", () => {
  test("supports exactly claude, cursor, and codex", () => {
    expect(CLIENTS.map((c) => c.id).sort()).toEqual(["claude", "codex", "cursor"]);
  });

  test("each client has a distinct manifest dir and marketplace path", () => {
    const dirs = CLIENTS.map((c) => c.pluginManifestDir);
    const paths = CLIENTS.map((c) => c.marketplacePath);
    expect(new Set(dirs).size).toBe(CLIENTS.length);
    expect(new Set(paths).size).toBe(CLIENTS.length);
  });

  test("canonical marketplace paths", () => {
    expect(byId("claude").marketplacePath).toBe(CLAUDE_MARKETPLACE_PATH);
    expect(byId("cursor").marketplacePath).toBe(CURSOR_MARKETPLACE_PATH);
    expect(byId("codex").marketplacePath).toBe(CODEX_MARKETPLACE_PATH);
    expect(CODEX_MARKETPLACE_PATH).toBe(".agents/plugins/marketplace.json");
  });

  test("pluginManifestPath places plugin.json in the client dir", () => {
    expect(pluginManifestPath(byId("claude"), "plugins/x")).toBe(
      "plugins/x/.claude-plugin/plugin.json",
    );
    expect(pluginManifestPath(byId("cursor"), "plugins/x")).toBe(
      "plugins/x/.cursor-plugin/plugin.json",
    );
    expect(pluginManifestPath(byId("codex"), "plugins/x")).toBe(
      "plugins/x/.codex-plugin/plugin.json",
    );
  });
});

describe("marketplace entry shapes", () => {
  const input = { name: "writing", source: "./plugins/writing", description: "d" };

  test("Claude and Cursor use the simple string-source shape", () => {
    for (const id of ["claude", "cursor"] as const) {
      expect(byId(id).marketplaceEntry(input)).toEqual({
        name: "writing",
        source: "./plugins/writing",
        description: "d",
      });
    }
  });

  test("Codex uses a structured local source, policy, and category", () => {
    expect(byId("codex").marketplaceEntry(input)).toEqual({
      name: "writing",
      source: { source: "local", path: "./plugins/writing" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
  });
});

describe("emptyMarketplace", () => {
  test("Claude carries owner + description", () => {
    expect(byId("claude").emptyMarketplace(SEED)).toEqual({
      name: "skills",
      owner: { name: "Skills Team" },
      description: "Skills synced from Notion.",
      plugins: [],
    });
  });

  test("Cursor carries owner + metadata.description", () => {
    expect(byId("cursor").emptyMarketplace(SEED)).toEqual({
      name: "skills",
      owner: { name: "Skills Team" },
      metadata: { description: "Skills synced from Notion." },
      plugins: [],
    });
  });

  test("Codex carries interface.displayName", () => {
    expect(byId("codex").emptyMarketplace(SEED)).toEqual({
      name: "skills",
      interface: { displayName: "Skills" },
      plugins: [],
    });
  });
});

describe("mergeMarketplace", () => {
  test("preserves non-controlled, adds+sorts controlled, prunes removed", () => {
    const existing = {
      name: "m",
      plugins: [
        { name: "hello-world", source: "./plugins/hello-world" },
        { name: "gone", source: "./plugins/gone" },
      ],
    };
    const merged = mergeMarketplace(
      existing,
      [
        { name: "zebra", source: "./plugins/zebra" },
        { name: "apple", source: "./plugins/apple" },
      ],
      new Set(["gone", "zebra", "apple"]),
    );
    expect(merged.plugins.map((p) => p.name)).toEqual(["hello-world", "apple", "zebra"]);
  });

  test("preserves unknown top-level keys", () => {
    const merged = mergeMarketplace(
      { name: "m", interface: { displayName: "X" }, plugins: [] },
      [],
      new Set(),
    );
    expect(merged.interface).toEqual({ displayName: "X" });
  });
});
