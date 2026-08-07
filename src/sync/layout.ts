// The on-disk layout of a published plugin. `SKILL.md` is not ours — the API
// returns it already rendered. What's built here is the scaffolding around it:
// the per-client plugin.json manifests, the sync marker, and their paths.

import { pageUrl, type NotionEnv } from "../notion/env.ts";
import type { FileContent } from "../target/target.ts";
import {
  CLIENTS,
  pluginManifestPath,
  type MarketplaceEntryInput,
  type MarketplaceManifest,
} from "./clients.ts";

export type Marketplace = MarketplaceManifest;

/** One skill from the Skills API, resolved for this sync run. */
export interface SkillInput {
  skillId: string;
  /** Kebab-cased page title from the API. */
  name: string;
  /** `name`, made unique within the plugin. */
  slug: string;
  description: string;
  versionId: string;
  /**
   * Extracted archive content, keyed by skill-dir-relative POSIX path.
   * `undefined` when `versionId` matched: nothing was downloaded and the
   * existing skill dir is left untouched.
   */
  files?: Record<string, FileContent>;
}

export interface PluginInfo {
  /** Directory name under `pluginsDir`, and the marketplace entry name. */
  slug: string;
  description: string;
  author: string;
}

export interface NotionSourceMeta {
  env: NotionEnv;
  databaseId: string;
  skillsDataSourceId: string;
}

const json = (obj: unknown): string => JSON.stringify(obj, null, 2) + "\n";

export const MARKER_FILENAME = ".notion-sync.json";

// Identical bytes for Claude, Cursor, and Codex — only the directory differs.
export function buildPluginJson(plugin: PluginInfo): string {
  return json({
    name: plugin.slug,
    version: "1.0.0",
    description: plugin.description,
    author: { name: plugin.author },
  });
}

// The back-reference clients use to write changes back to Notion, and the flag
// that makes a plugin eligible for pruning. A byte-identical marker means the
// dir is up to date, which is how the sync skips an archive download entirely.
export function buildSyncMarker(skill: SkillInput, meta: NotionSourceMeta): string {
  return json({
    source: "notion",
    syncedBy: "notion-skills-github-sync",
    notion: {
      env: meta.env,
      databaseId: meta.databaseId || undefined,
      skillsDataSourceId: meta.skillsDataSourceId || undefined,
      directoryId: skill.skillId,
      url: pageUrl(meta.env, skill.skillId),
      versionId: skill.versionId,
    },
    skill: { slug: skill.slug, name: skill.name },
  });
}

export function pluginPaths(pluginsDir: string, pluginSlug: string, skillSlug: string) {
  const skillDir = `${pluginsDir}/${pluginSlug}/skills/${skillSlug}`;
  return { skillDir, marker: `${skillDir}/${MARKER_FILENAME}` };
}

// One plugin.json per supported client, written once per plugin.
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

// The archive's files plus our marker on top (ours wins on a name clash).
// Empty for a skill with no `files` — an unchanged dir `plan.ts` retains.
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

// Client-neutral; each client transforms this into its own entry shape.
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
