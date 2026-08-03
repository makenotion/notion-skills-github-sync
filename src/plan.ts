import {
  buildPluginManifestFiles,
  buildSkillFiles,
  marketplaceEntryInput,
  MARKER_FILENAME,
  pluginPaths,
  type NotionSourceMeta,
  type PluginInfo,
  type SkillInput,
} from "./convert.ts";
import {
  CLIENTS,
  mergeMarketplace,
  type ClientId,
  type MarketplaceEntryInput,
  type MarketplaceManifest,
} from "./clients.ts";
import { computeChanges, type FileContent, type TreeChanges } from "./diff.ts";
import type { InjectedPlugin } from "./updater.ts";

// Re-exported for convenience; canonical definitions live in clients.ts.
export {
  CLAUDE_MARKETPLACE_PATH,
  CURSOR_MARKETPLACE_PATH,
  CODEX_MARKETPLACE_PATH,
} from "./clients.ts";
// Back-compat alias: the Claude marketplace was the original single manifest.
export const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Plugins this tool manages are exactly those carrying a marker file next to
// their SKILL.md. The plugin slug is the directory under pluginsDir.
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
  changes: TreeChanges;
  // One merged marketplace manifest per supported client, keyed by client id.
  marketplaces: Record<ClientId, MarketplaceManifest>;
  // Back-compat convenience: the Claude marketplace.
  marketplace: MarketplaceManifest;
}

/** One plugin from the API, with the skills that belong to it. */
export interface PluginGroup {
  plugin: PluginInfo;
  skills: SkillInput[];
}

export function buildSyncPlan(opts: {
  /**
   * Every plugin the API reported, each with its own skills. One repo plugin
   * directory is written per group; a group with no skills is skipped entirely
   * (and pruned, if it used to exist).
   */
  plugins: PluginGroup[];
  existing: Map<string, string>; // repo path -> git blob sha
  // Existing marketplace manifests read from the repo, keyed by client id.
  // A missing entry is treated as an empty marketplace.
  existingMarketplaces: Partial<Record<ClientId, MarketplaceManifest>>;
  pluginsDir: string;
  meta: NotionSourceMeta;
  injected?: InjectedPlugin[]; // synthetic plugins added by the tool (e.g. updater)
}): SyncPlan {
  const { existing, pluginsDir, meta } = opts;
  const injected = opts.injected ?? [];
  // An empty plugin gets no directory and no marketplace entry — publishing a
  // skill-less plugin would just add a broken listing.
  const groups = opts.plugins.filter((g) => g.skills.length > 0);
  const allSkills = groups.flatMap((g) => g.skills);

  const desiredFiles: Record<string, FileContent> = {};
  for (const { plugin, skills } of groups) {
    Object.assign(desiredFiles, buildPluginManifestFiles(plugin, pluginsDir));
    for (const skill of skills) {
      Object.assign(desiredFiles, buildSkillFiles(skill, plugin.slug, pluginsDir, meta));
    }
  }
  // Injected plugins carry no Notion marker, so prune never touches them; they
  // are simply re-asserted on every sync (idempotent once written).
  for (const inj of injected) Object.assign(desiredFiles, inj.files);

  // Skills whose version_id already matched the repo: we downloaded nothing and
  // render nothing for them, so every prune rule has to step around their dirs
  // rather than treating "not in desiredFiles" as "no longer wanted".
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

  // Skill-level prune: a marker-bearing skill dir whose marker is no longer
  // desired at that path (the skill was renamed, moved, or deleted in Notion)
  // must be deleted even when its plugin lives on — plugins auto-discover skill
  // dirs, so a stale copy would keep shipping.
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

  // Overlay prune: a skill dir we're rewriting owns its entire subtree (the API
  // archive is the source of truth for it). When a skill loses an attachment,
  // the stale file must go even though the skill itself lives on. Retained dirs
  // are excluded by construction — they have no desired files at all.
  const desiredSkillDirs = Object.keys(desiredFiles)
    .filter((p) => p.endsWith(`/${MARKER_FILENAME}`))
    .map((p) => p.slice(0, p.length - MARKER_FILENAME.length));
  for (const skillDir of desiredSkillDirs) {
    for (const p of existing.keys()) {
      if (p.startsWith(skillDir) && desiredFiles[p] === undefined) deleteSet.add(p);
    }
  }
  const deletePaths = [...deleteSet];

  // Client-neutral listings: every non-empty Notion plugin, then any injected
  // plugins (e.g. the updater).
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

  const changes = computeChanges({ existing, desired: desiredFiles, deletePaths });

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
    marketplace: marketplaces.claude,
  };
}
