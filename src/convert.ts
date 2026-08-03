import type { FileContent } from "./diff.ts";
import {
  CLIENTS,
  mergeMarketplace as mergeMarketplaceGeneric,
  pluginManifestPath,
  type MarketplaceEntry,
  type MarketplaceEntryInput,
  type MarketplaceManifest,
} from "./clients.ts";

// Render Notion skill directories into on-disk plugin layouts.
//
// SKILL.md itself is no longer built here — the Notion skills API returns it
// already rendered (with `name`/`description` frontmatter) inside the skill
// directory archive. What's left is the plugin scaffolding around it: the
// per-client plugin.json manifests, the sync marker, and the paths they live at.

// Re-exported for callers that predate the multi-client split.
export type { MarketplaceEntry, MarketplaceEntryInput } from "./clients.ts";
export type Marketplace = MarketplaceManifest;

/**
 * One skill directory from the Notion skills API, resolved for this sync run.
 *
 * `files` is the extracted archive content (SKILL.md plus any attachments),
 * keyed by skill-dir-relative POSIX path. It is `undefined` when the
 * directory's `versionId` matches what the repo already has: nothing needs
 * rewriting, so the archive was never downloaded and the existing skill dir is
 * left untouched.
 */
export interface SkillInput {
  directoryId: string;
  /** Kebab-cased page title from the API; also the skill's directory name. */
  name: string;
  /** `name`, made unique across this run's skills. */
  slug: string;
  description: string;
  /** Opaque content hash from the API; drives both the marker and change detection. */
  versionId: string;
  files?: Record<string, FileContent>;
}

/** One plugin from the API, as published in the repo. */
export interface PluginInfo {
  /** Directory name under `pluginsDir`, and the marketplace entry name. */
  slug: string;
  description: string;
  author: string;
}

export interface NotionSourceMeta {
  env: string;
  databaseId: string;
  skillsDataSourceId: string;
}

const json = (obj: unknown): string => JSON.stringify(obj, null, 2) + "\n";

export const MARKER_FILENAME = ".notion-sync.json";

// The per-plugin manifest content: the plugin's shared identity, rendered to
// identical bytes for Claude, Cursor, and Codex — only the directory it's
// written into differs (see clients.ts).
export function buildPluginJson(plugin: PluginInfo): string {
  return json({
    name: plugin.slug,
    version: "1.0.0",
    description: plugin.description,
    author: { name: plugin.author },
  });
}

// Backward-compatible merge helper (Claude's marketplace shape). Prefer the
// generic `mergeMarketplace` from clients.ts for multi-client code.
export function mergeMarketplace(
  existing: MarketplaceManifest,
  desiredEntries: MarketplaceEntry[],
  controlledSlugs: Set<string>,
): MarketplaceManifest {
  return mergeMarketplaceGeneric(existing, desiredEntries, controlledSlugs);
}

// The back-reference Cowork clients use to know where a skill came from (and to
// write changes back to Notion later). Also marks the plugin as managed by this
// sync so pruning never touches hand-authored plugins.
//
// `versionId` comes straight from the API and changes exactly when the skill
// does, so a byte-identical marker means the skill dir is already up to date —
// which is how the sync decides to skip an archive download entirely.
export function buildSyncMarker(skill: SkillInput, meta: NotionSourceMeta): string {
  const idNoDashes = skill.directoryId.replace(/-/g, "");
  const host = meta.env === "prod" ? "www.notion.so" : `app.${meta.env}.notion.com`;
  return json({
    source: "notion",
    syncedBy: "notion-skills-github-sync",
    notion: {
      env: meta.env,
      databaseId: meta.databaseId || undefined,
      skillsDataSourceId: meta.skillsDataSourceId || undefined,
      directoryId: skill.directoryId,
      url: `https://${host}/p/${idNoDashes}`,
      versionId: skill.versionId,
    },
    skill: { slug: skill.slug, name: skill.name },
  });
}

// Repo-relative paths for one skill within a plugin.
export function pluginPaths(pluginsDir: string, pluginSlug: string, skillSlug: string) {
  const skillDir = `${pluginsDir}/${pluginSlug}/skills/${skillSlug}`;
  return { skillDir, marker: `${skillDir}/${MARKER_FILENAME}` };
}

// The plugin-level files (one plugin.json per supported client), keyed by
// repo-relative path. Written once per plugin, independent of its skills.
export function buildPluginManifestFiles(
  plugin: PluginInfo,
  pluginsDir: string,
): Record<string, FileContent> {
  const manifest = buildPluginJson(plugin);
  const root = `${pluginsDir}/${plugin.slug}`;
  const files: Record<string, FileContent> = {};
  for (const client of CLIENTS) files[pluginManifestPath(client, root)] = manifest;
  return files;
}

// All files for one skill's directory, keyed by repo-relative path: whatever
// came out of the API archive, plus the marker written on top (the marker is
// ours, so it always wins over a same-named archive entry).
//
// Returns an empty set for a skill with no `files` — an unchanged directory the
// sync deliberately left alone. `plan.ts` retains such dirs rather than pruning
// them.
export function buildSkillFiles(
  skill: SkillInput,
  pluginSlug: string,
  pluginsDir: string,
  meta: NotionSourceMeta,
): Record<string, FileContent> {
  if (!skill.files) return {};
  const p = pluginPaths(pluginsDir, pluginSlug, skill.slug);
  const files: Record<string, FileContent> = {};
  for (const [rel, content] of Object.entries(skill.files)) {
    files[`${p.skillDir}/${rel}`] = content;
  }
  files[p.marker] = buildSyncMarker(skill, meta);
  return files;
}

// The shared, client-neutral marketplace listing for the plugin. Each client
// transforms this into its own entry shape (see clients.ts).
export function marketplaceEntryInput(
  plugin: PluginInfo,
  pluginsDir: string,
): MarketplaceEntryInput {
  return {
    name: plugin.slug,
    source: `./${pluginsDir}/${plugin.slug}`,
    description: plugin.description,
  };
}
