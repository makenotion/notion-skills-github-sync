import {
  buildPluginFiles,
  marketplaceEntryInput,
  pluginDir,
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Every plugin directory currently under `pluginsDir`. Notion is the sole
// source of what's published, so anything here that this run didn't produce is
// pruned — no marker check, no carve-out for hand-authored plugins.
function detectPluginSlugs(existingFiles: Iterable<string>, pluginsDir: string): Set<string> {
  const re = new RegExp(`^${escapeRegex(pluginsDir)}/([^/]+)/`);
  const slugs = new Set<string>();
  for (const path of existingFiles) {
    const m = path.match(re);
    if (m && m[1]) slugs.add(m[1]);
  }
  return slugs;
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
  /** Total skills across every published plugin, retained ones included. */
  skillCount: number;
  changes: TargetChanges;
  // One merged marketplace manifest per supported client, keyed by client id.
  marketplaces: Record<ClientId, MarketplaceManifest>;
}

export function buildSyncPlan(opts: {
  /** One directory per plugin; a plugin with no skills is skipped and pruned. */
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
  // A skill-less plugin would just be a broken listing.
  const published = opts.plugins.filter((p) => p.skills.length > 0);

  const desiredFiles: Record<string, FileContent> = {};
  for (const plugin of published) {
    Object.assign(desiredFiles, buildPluginFiles(plugin, pluginsDir, meta));
  }
  // Carries no marker, so it's kept alive by `desiredSlugs` alone; re-asserted
  // every run, which means turning the injection off correctly prunes it.
  for (const inj of injected) Object.assign(desiredFiles, inj.files);

  const desiredSlugs = [...published.map((p) => p.slug), ...injected.map((i) => i.slug)];
  const prunedSlugs = [...detectPluginSlugs(existing.keys(), pluginsDir)].filter(
    (s) => !desiredSlugs.includes(s),
  );

  // Two rules, and that's the whole of pruning. A plugin we didn't publish goes
  // entirely; a plugin we *did* write owns its subtree, so a dropped skill or
  // attachment is cleaned up. Retained plugins appear in neither list: they
  // contribute no desired files, so "not desired" must not read as "unwanted".
  const ownedPrefixes = [
    ...published.filter((p) => p.files).map((p) => `${pluginDir(pluginsDir, p.slug)}/`),
    ...injected.map((i) => `${pluginDir(pluginsDir, i.slug)}/`),
  ];
  const deleteSet = new Set<string>();
  for (const path of existing.keys()) {
    const pruned = prunedSlugs.some((s) => path.startsWith(`${pluginDir(pluginsDir, s)}/`));
    const orphaned =
      desiredFiles[path] === undefined && ownedPrefixes.some((p) => path.startsWith(p));
    if (pruned || orphaned) deleteSet.add(path);
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
    skillCount: published.reduce((n, p) => n + p.skills.length, 0),
    changes: computeChanges({
      existing,
      desired: desiredFiles,
      deletePaths: [...deleteSet],
      contentId: opts.contentId,
    }),
    marketplaces,
  };
}
