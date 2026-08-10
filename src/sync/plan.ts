import {
  buildPluginFiles,
  marketplaceEntryInput,
  type NotionSourceMeta,
  type PluginInput,
} from "./layout.ts";
import {
  CLIENTS,
  mergeMarketplace,
  type ClientId,
  type MarketplaceEntry,
  type MarketplaceEntryInput,
  type MarketplaceManifest,
} from "./clients.ts";
import { computeChanges, type FileContent, type TargetChanges } from "../target/target.ts";
import type { InjectedPlugin } from "./updater.ts";

function pluginSlugForPath(path: string, pluginsDir: string): string | undefined {
  const prefix = `${pluginsDir}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : undefined;
}

export interface SyncPlan {
  desiredFiles: Record<string, FileContent>;
  deletePaths: string[];
  /** Notion-sourced plugins published by this run. */
  pluginSlugs: string[];
  /** Plugins left untouched because their version_id already matched. */
  retainedPlugins: string[];
  /** Tool-injected plugins (e.g. the updater). */
  injectedSlugs: string[];
  prunedSlugs: string[];
  changes: TargetChanges;
  // One merged marketplace manifest per supported client, keyed by client id.
  marketplaces: Record<ClientId, MarketplaceManifest>;
}

export function buildSyncPlan(opts: {
  /** One directory per plugin. */
  plugins: PluginInput[];
  existing: Map<string, string>; // target path -> content id
  // Keyed by client id; a missing entry means an empty marketplace.
  existingMarketplaces: Partial<Record<ClientId, MarketplaceManifest>>;
  pluginsDir: string;
  meta: NotionSourceMeta;
  injected?: InjectedPlugin[]; // synthetic plugins added by the tool (e.g. updater)
  /** The target's content-id function; how "already correct" is decided. */
  contentId: (content: FileContent) => string;
}): SyncPlan {
  const { existing, pluginsDir, meta } = opts;
  const injected = opts.injected ?? [];
  const existingSlugs = new Set<string>();
  for (const path of existing.keys()) {
    const slug = pluginSlugForPath(path, pluginsDir);
    if (slug) existingSlugs.add(slug);
  }
  // A known list/archive 404 retains an existing plugin, but does not publish a
  // broken marketplace entry for a plugin that has never been downloaded.
  const published = opts.plugins.filter((p) => !p.failed || existingSlugs.has(p.slug));

  const desiredFiles: Record<string, FileContent> = {};
  for (const plugin of published) {
    if (plugin.failed) continue;
    Object.assign(desiredFiles, buildPluginFiles(plugin, pluginsDir, meta));
  }
  // Carries no marker, so it's kept alive by `desiredSlugs` alone; re-asserted
  // every run, which means turning the injection off correctly prunes it.
  for (const inj of injected) Object.assign(desiredFiles, inj.files);

  const desiredSlugs = new Set([
    ...published.map((p) => p.slug),
    ...injected.map((i) => i.slug),
  ]);
  const refreshedSlugs = new Set([
    ...published.filter((p) => p.files).map((p) => p.slug),
    ...injected.map((i) => i.slug),
  ]);
  const prunedSlugs = [...existingSlugs].filter((slug) => !desiredSlugs.has(slug));

  // One pass over the old tree: absent plugins go entirely; refreshed plugins
  // are exact directory replacements. Cached plugins are left untouched.
  const deleteSet = new Set<string>();
  for (const path of existing.keys()) {
    const slug = pluginSlugForPath(path, pluginsDir);
    if (!slug) continue;
    if (!desiredSlugs.has(slug) || (refreshedSlugs.has(slug) && !(path in desiredFiles))) {
      deleteSet.add(path);
    }
  }

  const seen = new Set<string>();
  const uniqueInputs: MarketplaceEntryInput[] = [
    ...published.map((p) => marketplaceEntryInput(p, pluginsDir)),
    ...injected.map((i) => i.entry),
  ].filter((input) => {
    if (seen.has(input.name)) return false;
    seen.add(input.name);
    return true;
  });

  // One merged marketplace per client, each rendered from the same listings.
  const marketplaces = {} as Record<ClientId, MarketplaceManifest>;
  for (const client of CLIENTS) {
    const existingMp = opts.existingMarketplaces[client.id] ?? { plugins: [] };
    const entries: MarketplaceEntry[] = uniqueInputs.map((input) => client.marketplaceEntry(input));
    const merged = mergeMarketplace(existingMp, entries);
    marketplaces[client.id] = merged;
    desiredFiles[client.marketplacePath] = JSON.stringify(merged, null, 2) + "\n";
  }

  return {
    desiredFiles,
    deletePaths: [...deleteSet],
    pluginSlugs: published.map((p) => p.slug),
    retainedPlugins: published.filter((p) => !p.files).map((p) => p.slug),
    injectedSlugs: injected.map((i) => i.slug),
    prunedSlugs,
    changes: computeChanges({
      existing,
      desired: desiredFiles,
      deletePaths: [...deleteSet],
      contentId: opts.contentId,
    }),
    marketplaces,
  };
}
