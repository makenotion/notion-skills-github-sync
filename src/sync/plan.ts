// PURE: what the target should contain, and what has to go.
//
// The on-disk layout of a published plugin comes first: the archive maps straight
// onto the plugin directory, and we only add a Claude compatibility manifest
// derived from its root plugin.json plus the sync marker used for caching and
// write-back. `buildSyncPlan` then turns a run's resolved plugins into the
// desired file set, the prune set, each client's merged marketplace, and the
// changes the target has to apply.

import { pageUrl, type NotionEnv } from "../notion/env.ts";
import {
  CLIENTS,
  claudePluginManifestPath,
  mergeMarketplace,
  type ClientId,
  type MarketplaceEntry,
  type MarketplaceEntryInput,
  type MarketplaceManifest,
} from "./clients.ts";
import { computeChanges, type FileContent, type TargetChanges } from "../target/target.ts";
import type { InjectedPlugin } from "./updater.ts";

/** One plugin from the Plugins API, resolved for this sync run. */
export interface PluginInput {
  pluginId: string;
  /** Display name as the API reports it. */
  name: string;
  /** `name`, slugified and made unique across the run: the directory name. */
  slug: string;
  description: string;
  versionId: string;
  /**
   * Archive files, keyed by plugin-dir-relative POSIX path. `undefined` when
   * `versionId` matched: nothing was downloaded and the directory is left as is.
   */
  files?: Record<string, FileContent>;
  /** The archive fetch failed; treat as retained and retry next run. */
  failed?: boolean;
}

export interface NotionSourceMeta {
  env: NotionEnv;
  databaseId: string;
  skillsDataSourceId: string;
}

const json = (obj: unknown): string => JSON.stringify(obj, null, 2) + "\n";

const MARKER_FILENAME = ".notion-sync.json";
const LAYOUT_VERSION = 1;

export function pluginDir(pluginsDir: string, slug: string): string {
  return `${pluginsDir}/${slug}`;
}

export function markerPath(pluginsDir: string, slug: string): string {
  return `${pluginDir(pluginsDir, slug)}/${MARKER_FILENAME}`;
}

/**
 * One marker per plugin: the back-reference for write-back, and the whole of
 * change detection. A byte-identical marker means the directory is up to date,
 * which is what lets a run skip the archive download entirely.
 */
export function buildSyncMarker(plugin: PluginInput, meta: NotionSourceMeta): string {
  return json({
    source: "notion",
    syncedBy: "notion-skills-github-sync",
    layoutVersion: LAYOUT_VERSION,
    notion: {
      env: meta.env,
      databaseId: meta.databaseId || undefined,
      skillsDataSourceId: meta.skillsDataSourceId || undefined,
      pluginId: plugin.pluginId,
      url: pageUrl(meta.env, plugin.pluginId),
      versionId: plugin.versionId,
    },
    plugin: { slug: plugin.slug, name: plugin.name },
  });
}

function text(content: FileContent): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

/**
 * Claude still uses its legacy manifest location and requires metadata that is
 * optional in the Agent Plugins standard. Preserve the standard manifest as
 * supplied, filling only those missing Claude fields in the derived copy.
 */
export function buildClaudePluginManifest(
  plugin: PluginInput,
  rootManifest: FileContent,
): string {
  const parsed = JSON.parse(text(rootManifest)) as Record<string, unknown>;
  const nonEmpty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

  return json({
    ...parsed,
    name: nonEmpty(parsed.name) ? parsed.name : plugin.slug,
    version: nonEmpty(parsed.version) ? parsed.version : "1.0.0",
    description: nonEmpty(parsed.description) ? parsed.description : plugin.description,
    author: parsed.author ?? { name: plugin.name || "Skills Team" },
  });
}

/**
 * Everything a plugin's directory should contain: the archive's files, Claude's
 * derived compatibility manifest, and the marker.
 *
 * A retained plugin has no archive bytes in memory and contributes only its
 * marker. Its existing tree, including the Claude manifest generated on the last
 * download, is left untouched.
 */
export function buildPluginFiles(
  plugin: PluginInput,
  pluginsDir: string,
  meta: NotionSourceMeta,
): Record<string, FileContent> {
  const root = pluginDir(pluginsDir, plugin.slug);
  const files: Record<string, FileContent> = {};
  for (const [rel, content] of Object.entries(plugin.files ?? {})) {
    files[`${root}/${rel}`] = content;
  }
  if (plugin.files) {
    const manifest = plugin.files["plugin.json"];
    if (!manifest) throw new Error(`Plugin archive "${plugin.slug}" contained no plugin.json.`);
    files[claudePluginManifestPath(root)] = buildClaudePluginManifest(plugin, manifest);
  }
  files[markerPath(pluginsDir, plugin.slug)] = buildSyncMarker(plugin, meta);
  return files;
}

// Client-neutral; each client transforms this into its own entry shape.
export function marketplaceEntryInput(
  plugin: PluginInput,
  pluginsDir: string,
): MarketplaceEntryInput {
  return {
    name: plugin.slug,
    source: `./${pluginDir(pluginsDir, plugin.slug)}`,
    description: plugin.description,
  };
}

function pluginSlugForPath(path: string, pluginsDir: string): string | undefined {
  const prefix = `${pluginsDir}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : undefined;
}

/**
 * The plan's contract: the writes and deletes the target must apply, plus which
 * plugins the run published, kept, injected, and pruned (for logs and the commit
 * message). The desired file set and the per-client marketplaces are internal —
 * everything downstream needs is already folded into `changes`.
 */
export interface SyncPlan {
  /** Notion-sourced plugins published by this run. */
  pluginSlugs: string[];
  /** Plugins left untouched because their version_id already matched. */
  retainedPlugins: string[];
  /** Tool-injected plugins (e.g. the updater). */
  injectedSlugs: string[];
  prunedSlugs: string[];
  changes: TargetChanges;
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
  for (const client of CLIENTS) {
    const existingMp = opts.existingMarketplaces[client.id] ?? { plugins: [] };
    const entries: MarketplaceEntry[] = uniqueInputs.map((input) => client.marketplaceEntry(input));
    desiredFiles[client.marketplacePath] = json(mergeMarketplace(existingMp, entries));
  }

  return {
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
  };
}
