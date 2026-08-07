import {
  buildPluginManifestFiles,
  buildSkillFiles,
  marketplaceEntryInput,
  MARKER_FILENAME,
  pluginPaths,
  type NotionSourceMeta,
  type PluginInfo,
  type SkillInput,
} from "./layout.ts";
import {
  CLIENTS,
  mergeMarketplace,
  type ClientId,
  type MarketplaceEntryInput,
  type MarketplaceManifest,
} from "./clients.ts";
import { computeChanges, type FileContent, type TargetChanges } from "../target/target.ts";
import type { InjectedPlugin } from "./updater.ts";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Managed plugins are exactly those carrying a marker next to their SKILL.md.
export function detectManagedSlugs(
  existingFiles: Iterable<string>,
  pluginsDir: string,
): Set<string> {
  const re = new RegExp(
    `^${escapeRegex(pluginsDir)}/([^/]+)/skills/[^/]+/${escapeRegex(MARKER_FILENAME)}$`,
  );
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
  desiredSlugs: string[]; // Notion-sourced plugins
  injectedSlugs: string[]; // tool-injected plugins (e.g. updater)
  prunedSlugs: string[];
  /** Slugs of the skills this run published (changed and retained alike). */
  skillSlugs: string[];
  /** Skill slugs left untouched because their version_id already matched. */
  retainedSkills: string[];
  changes: TargetChanges;
  // One merged marketplace manifest per supported client, keyed by client id.
  marketplaces: Record<ClientId, MarketplaceManifest>;
}

/** One plugin from the API, with the skills that belong to it. */
export interface PluginGroup {
  plugin: PluginInfo;
  skills: SkillInput[];
}

export function buildSyncPlan(opts: {
  /** One directory per group; a group with no skills is skipped and pruned. */
  plugins: PluginGroup[];
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
  const groups = opts.plugins.filter((g) => g.skills.length > 0);
  const allSkills = groups.flatMap((g) => g.skills);

  const desiredFiles: Record<string, FileContent> = {};
  for (const { plugin, skills } of groups) {
    Object.assign(desiredFiles, buildPluginManifestFiles(plugin, pluginsDir));
    for (const skill of skills) {
      Object.assign(desiredFiles, buildSkillFiles(skill, plugin.slug, pluginsDir, meta));
    }
  }
  // No Notion marker, so prune never touches them; re-asserted every sync.
  for (const inj of injected) Object.assign(desiredFiles, inj.files);

  // version_id matched: nothing downloaded, nothing rendered. Every prune rule
  // must step around these dirs instead of reading "absent" as "unwanted".
  const retainedSkills = allSkills.filter((s) => !s.files);
  const retainedDirs = groups.flatMap(({ plugin, skills }) =>
    skills
      .filter((s) => !s.files)
      .map((s) => `${pluginPaths(pluginsDir, plugin.slug, s.slug).skillDir}/`),
  );
  const isRetained = (path: string) => retainedDirs.some((dir) => path.startsWith(dir));

  const notionPluginSlugs = groups.map((g) => g.plugin.slug);
  const injectedSlugs = injected.map((i) => i.slug);
  const desiredSlugs = [...notionPluginSlugs, ...injectedSlugs];
  const previouslyManaged = detectManagedSlugs(existing.keys(), pluginsDir);
  // Marketplace entries we control: marker-managed (Notion) + this run's desired.
  const controlled = new Set([...previouslyManaged, ...desiredSlugs]);
  // Only marker-managed Notion plugins are eligible for pruning.
  const prunedSlugs = [...previouslyManaged].filter((s) => !notionPluginSlugs.includes(s));

  const deleteSet = new Set<string>();
  for (const slug of prunedSlugs) {
    const prefix = `${pluginsDir}/${slug}/`;
    for (const path of existing.keys()) {
      if (path.startsWith(prefix)) deleteSet.add(path);
    }
  }

  // A marker-bearing dir whose marker is no longer desired at that path (skill
  // renamed, moved, or deleted) must go even when its plugin lives on —
  // plugins auto-discover skill dirs, so a stale copy would keep shipping.
  const markerRe = new RegExp(
    `^${escapeRegex(pluginsDir)}/[^/]+/skills/[^/]+/${escapeRegex(MARKER_FILENAME)}$`,
  );
  for (const path of existing.keys()) {
    if (!markerRe.test(path) || desiredFiles[path] !== undefined || isRetained(path)) continue;
    const skillDir = path.slice(0, path.length - MARKER_FILENAME.length);
    for (const p of existing.keys()) {
      if (p.startsWith(skillDir)) deleteSet.add(p);
    }
  }

  // A dir we're rewriting owns its whole subtree, so a dropped attachment gets
  // cleaned up. Retained dirs are excluded — they have no desired files at all.
  const desiredSkillDirs = Object.keys(desiredFiles)
    .filter((p) => p.endsWith(`/${MARKER_FILENAME}`))
    .map((p) => p.slice(0, p.length - MARKER_FILENAME.length));
  for (const skillDir of desiredSkillDirs) {
    for (const p of existing.keys()) {
      if (p.startsWith(skillDir) && desiredFiles[p] === undefined) deleteSet.add(p);
    }
  }
  const deletePaths = [...deleteSet];

  const seenPlugins = new Set<string>();
  const uniqueInputs: MarketplaceEntryInput[] = [
    ...groups.map((g) => marketplaceEntryInput(g.plugin, pluginsDir)),
    ...injected.map((i) => i.entry),
  ].filter((input) => {
    if (seenPlugins.has(input.name)) return false;
    seenPlugins.add(input.name);
    return true;
  });

  // One merged marketplace per client, each rendered from the same listings.
  const marketplaces = {} as Record<ClientId, MarketplaceManifest>;
  for (const client of CLIENTS) {
    const existingMp = opts.existingMarketplaces[client.id] ?? { plugins: [] };
    const merged = mergeMarketplace(
      existingMp,
      uniqueInputs.map((input) => client.marketplaceEntry(input)),
      controlled,
    );
    marketplaces[client.id] = merged;
    desiredFiles[client.marketplacePath] = JSON.stringify(merged, null, 2) + "\n";
  }

  const changes = computeChanges({
    existing,
    desired: desiredFiles,
    deletePaths,
    contentId: opts.contentId,
  });

  return {
    desiredFiles,
    deletePaths,
    desiredSlugs: notionPluginSlugs,
    injectedSlugs,
    prunedSlugs,
    skillSlugs: allSkills.map((s) => s.slug),
    retainedSkills: retainedSkills.map((s) => s.slug),
    changes,
    marketplaces,
  };
}
