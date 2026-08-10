// The on-disk layout of a published plugin. The archive maps straight onto the
// plugin directory. We only add a Claude compatibility manifest derived from
// its root plugin.json and the sync marker used for caching and write-back.

import { pageUrl, type NotionEnv } from "../notion/env.ts";
import type { FileContent } from "../target/target.ts";
import { claudePluginManifestPath, type MarketplaceEntryInput } from "./clients.ts";

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
