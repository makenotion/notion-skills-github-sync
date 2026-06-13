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
  desiredSlugs: string[];
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
}): SyncPlan {
  const { skills, existing, pluginsDir, meta } = opts;

  const desiredFiles: Record<string, string> = {};
  for (const skill of skills) {
    Object.assign(desiredFiles, buildPluginFiles(skill, pluginsDir, meta));
  }

  const desiredSlugs = skills.map((s) => s.slug);
  const previouslyManaged = detectManagedSlugs(existing.keys(), pluginsDir);
  const controlled = new Set([...previouslyManaged, ...desiredSlugs]);
  const prunedSlugs = [...previouslyManaged].filter((s) => !desiredSlugs.includes(s));

  const deletePaths: string[] = [];
  for (const slug of prunedSlugs) {
    const prefix = `${pluginsDir}/${slug}/`;
    for (const path of existing.keys()) {
      if (path.startsWith(prefix)) deletePaths.push(path);
    }
  }

  const marketplace = mergeMarketplace(
    opts.existingMarketplace,
    skills.map((s) => marketplaceEntry(s, pluginsDir)),
    controlled,
  );
  desiredFiles[MARKETPLACE_PATH] = JSON.stringify(marketplace, null, 2) + "\n";

  const changes = computeChanges({ existing, desired: desiredFiles, deletePaths });

  return { desiredFiles, deletePaths, desiredSlugs, prunedSlugs, changes, marketplace };
}
