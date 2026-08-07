// Every client reads the *same* per-plugin manifest content; they disagree only
// on WHERE it lives and on the shape of the repo-root marketplace file. This is
// the one place those differences live.
//
// Conventions (verified against each client's docs):
//   Claude Code : per-plugin  <plugin>/.claude-plugin/plugin.json
//                 marketplace  .claude-plugin/marketplace.json
//                 entry        { name, source: "./path", description }
//   Cursor      : per-plugin  <plugin>/.cursor-plugin/plugin.json
//                 marketplace  .cursor-plugin/marketplace.json
//                 entry        { name, source: "./path", description }
//   Codex       : per-plugin  <plugin>/.codex-plugin/plugin.json
//                 marketplace  .agents/plugins/marketplace.json
//                 entry        { name, source: { source, path }, policy, category }

export type ClientId = "claude" | "cursor" | "codex";

// Client-shaped, but every client keys entries by `name` — all the merge/prune
// logic needs.
export type MarketplaceEntry = { name: string; [key: string]: unknown };

// Extra top-level keys (owner, interface, …) vary by client and survive merges.
export interface MarketplaceManifest {
  name?: string;
  plugins: MarketplaceEntry[];
  [key: string]: unknown;
}

export interface MarketplaceEntryInput {
  name: string; // plugin slug
  source: string; // repo-relative "./<pluginsDir>/<slug>"
  description: string;
}

// Seed used to synthesize a fresh (empty) marketplace when the repo doesn't have
// one yet. Existing marketplaces are read from the repo and merged into instead.
export interface MarketplaceSeed {
  name: string; // marketplace identifier (kebab-case)
  owner: { name: string; email?: string };
  displayName: string; // human label (Codex interface.displayName)
  description: string;
}

export interface ClientSpec {
  id: ClientId;
  label: string; // human name for docs/logs
  // Directory (relative to the plugin root) holding this client's plugin.json.
  pluginManifestDir: string;
  // Repo-root-relative path to this client's marketplace manifest.
  marketplacePath: string;
  // Transform the shared listing into this client's entry shape.
  marketplaceEntry(input: MarketplaceEntryInput): MarketplaceEntry;
  // Build a fresh, empty marketplace manifest for this client.
  emptyMarketplace(seed: MarketplaceSeed): MarketplaceManifest;
}

export const CLAUDE_MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
export const CURSOR_MARKETPLACE_PATH = ".cursor-plugin/marketplace.json";
export const CODEX_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";

export const CLIENTS: ClientSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    pluginManifestDir: ".claude-plugin",
    marketplacePath: CLAUDE_MARKETPLACE_PATH,
    marketplaceEntry: ({ name, source, description }) => ({ name, source, description }),
    emptyMarketplace: (seed) => ({
      name: seed.name,
      owner: seed.owner,
      description: seed.description,
      plugins: [],
    }),
  },
  {
    id: "cursor",
    label: "Cursor",
    pluginManifestDir: ".cursor-plugin",
    marketplacePath: CURSOR_MARKETPLACE_PATH,
    // Cursor entries mirror Claude's (name + string source + description).
    marketplaceEntry: ({ name, source, description }) => ({ name, source, description }),
    emptyMarketplace: (seed) => ({
      name: seed.name,
      owner: seed.owner,
      metadata: { description: seed.description },
      plugins: [],
    }),
  },
  {
    id: "codex",
    label: "Codex",
    pluginManifestDir: ".codex-plugin",
    marketplacePath: CODEX_MARKETPLACE_PATH,
    // Codex uses a structured local source + an install policy + a category.
    marketplaceEntry: ({ name, source }) => ({
      name,
      source: { source: "local", path: source },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }),
    emptyMarketplace: (seed) => ({
      name: seed.name,
      interface: { displayName: seed.displayName },
      plugins: [],
    }),
  },
];

// Repo-relative path to a plugin's manifest for a given client.
export function pluginManifestPath(client: ClientSpec, pluginRoot: string): string {
  return `${pluginRoot}/${client.pluginManifestDir}/plugin.json`;
}

// Replace the plugin list outright: Notion is the sole source of what's
// published, so the entries this run produced are the entries, sorted for
// deterministic output. An entry whose plugin went away disappears with it.
//
// The existing manifest's other top-level keys (name, owner, description, …)
// ARE kept — those are the repo's own identity, not a plugin listing, and
// nothing in Notion supplies them.
export function mergeMarketplace(
  existing: MarketplaceManifest,
  desiredEntries: MarketplaceEntry[],
): MarketplaceManifest {
  const sorted = [...desiredEntries].sort((a, b) => a.name.localeCompare(b.name));
  return { ...existing, plugins: sorted };
}
