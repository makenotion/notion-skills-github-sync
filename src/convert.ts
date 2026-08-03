// Plugin-manifest + marketplace-listing helpers.
//
// Since the Notion AI plugins/skills API now packages each skill directory into
// a zip and groups directories by plugin, the sync no longer renders SKILL.md
// bodies, sync markers, or descriptions itself. What's left here is the small
// bit of repo-level metadata the API can't produce: the per-plugin `plugin.json`
// manifest (one per client, identical bytes) and each plugin's client-neutral
// marketplace listing.

import {
  mergeMarketplace as mergeMarketplaceGeneric,
  type MarketplaceEntry,
  type MarketplaceEntryInput,
  type MarketplaceManifest,
} from "./clients.ts";

// Re-exported for callers that predate the multi-client split.
export type { MarketplaceEntry, MarketplaceEntryInput } from "./clients.ts";
export type Marketplace = MarketplaceManifest;

// The plugin's shared identity/metadata. Every client's plugin.json is rendered
// from this exact object, so updating a field here updates every generated
// manifest.
export interface PluginMeta {
  name: string;
  version: string;
  description: string;
  author: { name: string };
}

const json = (obj: unknown): string => JSON.stringify(obj, null, 2) + "\n";

// The per-plugin manifest content. Identical bytes for Claude, Cursor, and
// Codex — only the directory it's written into differs (see clients.ts).
export function buildPluginJson(meta: PluginMeta): string {
  return json(meta);
}

// The shared, client-neutral marketplace listing for a plugin. Each client
// transforms this into its own entry shape (see clients.ts).
export function marketplaceListing(
  plugin: { name: string; description: string },
  pluginsDir: string,
): MarketplaceEntryInput {
  return {
    name: plugin.name,
    source: `./${pluginsDir}/${plugin.name}`,
    description: plugin.description,
  };
}

// Backward-compatible merge helper. Prefer the generic `mergeMarketplace` from
// clients.ts for multi-client code.
export function mergeMarketplace(
  existing: MarketplaceManifest,
  desiredEntries: MarketplaceEntry[],
  controlledSlugs: Set<string>,
): MarketplaceManifest {
  return mergeMarketplaceGeneric(existing, desiredEntries, controlledSlugs);
}
