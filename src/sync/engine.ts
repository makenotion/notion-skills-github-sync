// Read a workspace's skills, decide what the target should contain, hand over
// the difference. Nothing here knows about GitHub: the two edges are a
// `SkillsSource` and a `SyncTarget`, which is what lets the pipeline run end to
// end with no network in tests.

import type { NotionEnv } from "../notion/env.ts";
import type { PluginSkillRef, ResolvedPluginFiles, Skill, SkillsPlugin } from "../notion/plugins.ts";
import {
  hasChanges,
  type FileContent,
  type SyncTarget,
  type TargetState,
} from "../target/target.ts";
import {
  CLIENTS,
  type ClientId,
  type MarketplaceManifest,
  type MarketplaceSeed,
} from "./clients.ts";
import {
  buildSyncMarker,
  pluginPaths,
  type NotionSourceMeta,
  type PluginInfo,
  type SkillInput,
} from "./layout.ts";
import { buildSyncPlan, type PluginGroup, type SyncPlan } from "./plan.ts";
import { assignUniqueSlugs } from "./slugify.ts";
import { buildUpdaterPlugin, type InjectedPlugin } from "./updater.ts";

/** The slice of the Notion client the sync depends on. */
export interface SkillsSource {
  plugins: {
    listAll(): Promise<SkillsPlugin[]>;
    files(args: { plugin_id: string; skills: PluginSkillRef[] }): Promise<ResolvedPluginFiles>;
  };
}

/** Everything about *what* to publish, independent of where it goes. */
export interface SyncSettings {
  notionEnv: NotionEnv;
  pluginsDir: string;
  /** Fallback directory name for a plugin the API reports with no name. */
  pluginSlug: string;
  /** Recorded in markers and used by the updater's write-back guidance. */
  skillsDatabaseId: string;
  skillsDataSourceId: string;
  /** Optional; enables the updater's "propose a change" path when set. */
  changeRequestsDataSourceId: string;
  injectUpdater: boolean;
  updaterSlug: string;
}

export interface SyncOptions {
  source: SkillsSource;
  target: SyncTarget;
  settings: SyncSettings;
  dryRun?: boolean;
  /** Progress output. Defaults to console.log; pass a no-op to silence. */
  log?: (message: string) => void;
}

export interface SyncResult {
  committed: boolean;
  revision?: string;
  plan: SyncPlan;
  /** The base state the plan was computed against. */
  base: TargetState;
}

// Synthesizes a fresh marketplace when a client's manifest doesn't exist yet.
export const MARKETPLACE_SEED: MarketplaceSeed = {
  name: "skills",
  owner: { name: "Skills Team" },
  displayName: "Skills",
  description: "Skills synced from Notion.",
};

/**
 * Slugs are unique within the plugin, not across the run — two plugins may each
 * hold a skill with the same title. A plugin now travels as one archive, so its
 * skills are downloaded together: the archive is fetched only when at least one
 * of the plugin's skills changed (its `version_id` moved) or lost its SKILL.md,
 * which keeps an unchanged hourly run to a few cheap GETs. When the archive is
 * fetched, every skill in the plugin is refreshed from it — a byte-identical
 * sibling still produces no write, and a stale one self-heals for free.
 */
export async function resolveSkills(args: {
  pluginId: string;
  plugin: PluginInfo;
  skills: SkillsPlugin["skills"];
  source: SkillsSource;
  /** Target path -> content id, for the whole base state. */
  existing: Map<string, string>;
  contentId: (content: FileContent) => string;
  pluginsDir: string;
  meta: NotionSourceMeta;
  log?: (message: string) => void;
}): Promise<SkillInput[]> {
  const { pluginId, plugin, source, existing, contentId, pluginsDir, meta } = args;
  const log = args.log ?? (() => {});

  const slugs = assignUniqueSlugs(args.skills, (s: Skill) => s.name);
  const skills: SkillInput[] = args.skills.map((apiSkill) => ({
    skillId: apiSkill.id,
    name: apiSkill.name,
    slug: slugs.get(apiSkill)!,
    description: apiSkill.description,
    versionId: apiSkill.version_id,
  }));

  // A byte-identical marker means the dir is up to date; SKILL.md must be
  // present too, so a hand-deleted file heals instead of hiding behind a
  // matching marker. Compare content ids, not contents: `existing` is already
  // in memory, so this costs nothing. Reading markers back would be one GET per
  // skill — the biggest cost of a no-op run.
  const upToDate = (skill: SkillInput): boolean => {
    const paths = pluginPaths(pluginsDir, plugin.slug, skill.slug);
    return (
      existing.has(`${paths.skillDir}/SKILL.md`) &&
      existing.get(paths.marker) === contentId(buildSyncMarker(skill, meta))
    );
  };

  // Nothing in this plugin moved: retain every skill as-is, download nothing.
  if (skills.every(upToDate)) return skills;

  const { bySlug, unmatchedDirs } = await source.plugins.files({
    plugin_id: pluginId,
    skills: skills.map((s) => ({ id: s.skillId, slug: s.slug, name: s.name })),
  });
  for (const dir of unmatchedDirs) {
    log(`  ⚠ ${plugin.slug}: archive skill "${dir}" matched no listed skill; ignored.`);
  }

  for (const skill of skills) {
    const resolved = bySlug[skill.slug];
    if (!resolved) {
      log(`  ⚠ ${plugin.slug}/${skill.slug}: not present in the plugin archive.`);
      continue; // no `files` -> retained as-is
    }
    for (const s of resolved.skipped) {
      log(`  ⚠ ${skill.slug}: skipped unsafe archive entry "${s}".`);
    }
    if (resolved.expandedZip) log(`  + ${skill.slug}: expanded ${resolved.expandedZip} in place.`);
    if (!resolved.files["SKILL.md"]) log(`  ⚠ ${skill.slug}: archive contained no SKILL.md.`);
    skill.files = resolved.files;
  }

  return skills;
}

export function commitMessage(plan: SyncPlan, env: NotionEnv): string {
  const lines = [
    `notion-skills sync: ${plan.skillSlugs.length} skill(s)` +
      ` [~${plan.changes.write.length} files, -${plan.changes.delete.length}]`,
    "",
    `Synced from the Notion plugins API (${env}).`,
    `Skills: ${plan.skillSlugs.join(", ") || "(none)"}`,
  ];
  if (plan.prunedSlugs.length) lines.push(`Pruned: ${plan.prunedSlugs.join(", ")}`);
  return lines.join("\n");
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const { source, target, settings } = opts;
  const log = opts.log ?? ((m: string) => console.log(m));

  // 1. Read the target's current state.
  const base = await target.readState();

  // Merge into each client's existing manifest rather than clobbering
  // hand-authored entries. Missing files are seeded fresh.
  const existingMarketplaces: Partial<Record<ClientId, MarketplaceManifest>> = {};
  for (const client of CLIENTS) {
    const content = base.files.has(client.marketplacePath)
      ? await target.readText(client.marketplacePath)
      : null;
    if (content === null) {
      existingMarketplaces[client.id] = client.emptyMarketplace(MARKETPLACE_SEED);
      continue;
    }
    try {
      const parsed = JSON.parse(content) as MarketplaceManifest;
      if (!Array.isArray(parsed.plugins)) parsed.plugins = [];
      existingMarketplaces[client.id] = parsed;
    } catch {
      throw new Error(
        `Existing ${client.marketplacePath} in ${target.label} is not valid JSON; refusing to overwrite.`,
      );
    }
  }

  // 2. Read the workspace's skills. One plugin per skills grouping (per-team
  // plugins plus Notion's built-in one); each becomes its own directory.
  const apiPlugins = await source.plugins.listAll();
  const pluginSlugs = assignUniqueSlugs(apiPlugins, (p) => p.name || settings.pluginSlug);
  const totalSkills = apiPlugins.reduce((n, p) => n + (p.skills?.length ?? 0), 0);
  log(
    `Notion: ${totalSkills} skill(s) across ${apiPlugins.length} plugin(s): ` +
      (apiPlugins.map((p) => `${pluginSlugs.get(p)} (${p.skills?.length ?? 0})`).join(", ") ||
        "(none)"),
  );
  if (totalSkills === 0) {
    log(
      "  No skills visible to this token. Check that the Notion connection has " +
        "access to your skills, or add a skill in Notion.",
    );
  }

  const meta: NotionSourceMeta = {
    env: settings.notionEnv,
    databaseId: settings.skillsDatabaseId,
    skillsDataSourceId: settings.skillsDataSourceId,
  };

  const groups: PluginGroup[] = [];
  for (const apiPlugin of apiPlugins) {
    const plugin: PluginInfo = {
      slug: pluginSlugs.get(apiPlugin)!,
      description: apiPlugin.description || MARKETPLACE_SEED.description,
      author: apiPlugin.name || MARKETPLACE_SEED.owner.name,
    };
    const skills = await resolveSkills({
      pluginId: apiPlugin.id,
      plugin,
      skills: apiPlugin.skills ?? [],
      source,
      existing: base.files,
      contentId: (c) => target.contentId(c),
      pluginsDir: settings.pluginsDir,
      meta,
      log,
    });
    groups.push({ plugin, skills });
  }

  const injected: InjectedPlugin[] = settings.injectUpdater
    ? [
        buildUpdaterPlugin({
          pluginsDir: settings.pluginsDir,
          slug: settings.updaterSlug,
          env: settings.notionEnv,
          skillsDataSourceId: settings.skillsDataSourceId,
          changeRequestsDataSourceId: settings.changeRequestsDataSourceId,
        }),
      ]
    : [];

  // 3. Plan.
  const plan = buildSyncPlan({
    plugins: groups,
    existing: base.files,
    existingMarketplaces,
    pluginsDir: settings.pluginsDir,
    meta,
    injected,
    contentId: (c) => target.contentId(c),
  });

  reportPlan(plan, base, target, log);

  if (opts.dryRun) {
    log("\n(dry run — nothing written)");
    return { committed: false, plan, base };
  }

  if (!hasChanges(plan.changes)) {
    log("\n✓ Up to date — nothing to write.");
    return { committed: false, plan, base };
  }

  // 4. Apply.
  const result = await target.apply(plan.changes, {
    message: commitMessage(plan, settings.notionEnv),
  });
  if (!result.changed) {
    log("\n✓ Target unchanged — nothing written.");
    return { committed: false, plan, base };
  }

  log(`\n✓ Wrote ${result.revision?.slice(0, 7) ?? "changes"} to ${target.label}`);
  if (result.url) log(`  ${result.url}`);
  return { committed: true, revision: result.revision, plan, base };
}

function reportPlan(
  plan: SyncPlan,
  base: TargetState,
  target: SyncTarget,
  log: (message: string) => void,
): void {
  log(`\nPlan (base: ${base.label} -> ${target.label}):`);
  log(`  skills         : ${plan.skillSlugs.join(", ") || "(none)"}`);
  if (plan.retainedSkills.length) log(`  unchanged      : ${plan.retainedSkills.join(", ")}`);
  if (plan.injectedSlugs.length) log(`  injected       : ${plan.injectedSlugs.join(", ")}`);
  log(`  files changed  : ${plan.changes.write.length}`);
  log(`  files unchanged: ${plan.changes.unchanged}`);
  log(`  files deleted  : ${plan.changes.delete.length}`);
  if (plan.prunedSlugs.length) log(`  pruned plugins : ${plan.prunedSlugs.join(", ")}`);
  for (const c of plan.changes.write) log(`    ~ ${c.path}`);
  for (const d of plan.changes.delete) log(`    - ${d}`);
}
