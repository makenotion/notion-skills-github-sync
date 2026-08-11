// Every client reads the Agent Plugins manifest at <plugin>/plugin.json. Claude
// also needs a derived manifest at <plugin>/.claude-plugin/plugin.json. The
// clients still disagree on the shape of the repo-root marketplace file; this
// is the one place those differences live.
//
// Conventions (verified against each client's docs):
//   Claude Code : per-plugin  <plugin>/plugin.json plus a compatibility manifest at
//                              <plugin>/.claude-plugin/plugin.json
//                 marketplace  .claude-plugin/marketplace.json
//                 entry        { name, source: "./path", description }
//   Cursor      : per-plugin  <plugin>/plugin.json
//                 marketplace  .cursor-plugin/marketplace.json
//                 entry        { name, source: "./path", description }
//   Codex       : per-plugin  <plugin>/plugin.json
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

export interface ClientSpec {
  id: ClientId;
  label: string; // human name for docs/logs
  // Repo-root-relative path to this client's marketplace manifest.
  marketplacePath: string;
  // Transform the shared listing into this client's entry shape.
  marketplaceEntry(input: MarketplaceEntryInput): MarketplaceEntry;
  // A fresh, empty marketplace, synthesized when the repo doesn't have this
  // client's manifest yet. Existing manifests are read and merged into instead,
  // so these identity keys are only ever written once. Returns a new object per
  // call — the manifest is mutated downstream.
  emptyMarketplace(): MarketplaceManifest;
}

export const CLAUDE_MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
export const CURSOR_MARKETPLACE_PATH = ".cursor-plugin/marketplace.json";
export const CODEX_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";

export const CLIENTS: ClientSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    marketplacePath: CLAUDE_MARKETPLACE_PATH,
    marketplaceEntry: ({ name, source, description }) => ({ name, source, description }),
    emptyMarketplace: () => ({
      name: "skills",
      owner: { name: "Skills Team" },
      description: "Skills synced from Notion.",
      plugins: [],
    }),
  },
  {
    id: "cursor",
    label: "Cursor",
    marketplacePath: CURSOR_MARKETPLACE_PATH,
    // Cursor entries mirror Claude's (name + string source + description).
    marketplaceEntry: ({ name, source, description }) => ({ name, source, description }),
    emptyMarketplace: () => ({
      name: "skills",
      owner: { name: "Skills Team" },
      metadata: { description: "Skills synced from Notion." },
      plugins: [],
    }),
  },
  {
    id: "codex",
    label: "Codex",
    marketplacePath: CODEX_MARKETPLACE_PATH,
    // Codex uses a structured local source + an install policy + a category.
    marketplaceEntry: ({ name, source }) => ({
      name,
      source: { source: "local", path: source },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }),
    emptyMarketplace: () => ({
      name: "skills",
      interface: { displayName: "Skills" },
      plugins: [],
    }),
  },
];

/** Claude's compatibility manifest derived from the standard root plugin.json. */
export function claudePluginManifestPath(pluginRoot: string): string {
  return `${pluginRoot}/.claude-plugin/plugin.json`;
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
