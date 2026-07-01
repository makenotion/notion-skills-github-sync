import {
  buildPluginFiles,
  marketplaceEntry,
  mergeMarketplace,
  MARKER_FILENAME,
  type Marketplace,
  type NotionSourceMeta,
  type SkillInput,
} from "./convert.ts";
import { computeChanges, type TreeChanges } from "./diff.ts";
import type { InjectedPlugin } from "./updater.ts";

// Canonical Claude Code plugin-marketplace manifest location.
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
  desiredFiles: Record<string, string>;
  deletePaths: string[];
  desiredSlugs: string[]; // Notion-sourced skills
  injectedSlugs: string[]; // tool-injected plugins (e.g. updater)
  prunedSlugs: string[];
  changes: TreeChanges;
  marketplace: Marketplace;
}

export function buildSyncPlan(opts: {
  skills: SkillInput[];
  existing: Map<string, string>; // repo path -> git blob sha
  existingMarketplace: Marketplace;
  pluginsDir: string;
  meta: NotionSourceMeta;
  injected?: InjectedPlugin[]; // synthetic plugins added by the tool (e.g. updater)
}): SyncPlan {
  const { skills, existing, pluginsDir, meta } = opts;
  const injected = opts.injected ?? [];

  const desiredFiles: Record<string, string> = {};
  for (const skill of skills) {
    Object.assign(desiredFiles, buildPluginFiles(skill, pluginsDir, meta));
  }
  // Injected plugins carry no Notion marker, so prune never touches them; they
  // are simply re-asserted on every sync (idempotent once written).
  for (const inj of injected) Object.assign(desiredFiles, inj.files);

  // Collect unique plugin slugs (multiple skills may share a plugin).
  const notionPluginSlugs = [...new Set(skills.map((s) => s.pluginSlug))];
  const injectedSlugs = injected.map((i) => i.slug);
  const desiredSlugs = [...notionPluginSlugs, ...injectedSlugs];
  const previouslyManaged = detectManagedSlugs(existing.keys(), pluginsDir);
  // Marketplace entries we control: marker-managed (Notion) + this run's desired.
  const controlled = new Set([...previouslyManaged, ...desiredSlugs]);
  // Only marker-managed Notion plugins are eligible for pruning.
  const prunedSlugs = [...previouslyManaged].filter((s) => !notionPluginSlugs.includes(s));

  const deletePaths: string[] = [];
  for (const slug of prunedSlugs) {
    const prefix = `${pluginsDir}/${slug}/`;
    for (const path of existing.keys()) {
      if (path.startsWith(prefix)) deletePaths.push(path);
    }
  }

  // Deduplicate marketplace entries by pluginSlug (multiple skills may share a plugin).
  // Use the first skill's entry for each plugin (description comes from first skill).
  const seenPlugins = new Set<string>();
  const uniqueEntries = skills
    .map((s) => marketplaceEntry(s, pluginsDir))
    .filter((entry) => {
      if (seenPlugins.has(entry.name)) return false;
      seenPlugins.add(entry.name);
      return true;
    });

  const marketplace = mergeMarketplace(
    opts.existingMarketplace,
    [...uniqueEntries, ...injected.map((i) => i.entry)],
    controlled,
  );
  desiredFiles[MARKETPLACE_PATH] = JSON.stringify(marketplace, null, 2) + "\n";

  const changes = computeChanges({ existing, desired: desiredFiles, deletePaths });

  return {
    desiredFiles,
    deletePaths,
    desiredSlugs: notionPluginSlugs,
    injectedSlugs,
    prunedSlugs,
    changes,
    marketplace,
  };
}
