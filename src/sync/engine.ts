// Read a workspace's plugins, decide what the target should contain, hand over
// the difference. Nothing here knows about GitHub: the two edges are a
// `PluginSource` and a `SyncTarget`, which is what lets the pipeline run end to
// end with no network in tests.

import type { NotionEnv } from "../notion/env.ts";
import type { PluginFiles } from "../notion/archive.ts";
import type { Plugin } from "../notion/plugins.ts";
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
  markerPath,
  pluginDir,
  type NotionSourceMeta,
  type PluginInput,
} from "./layout.ts";
import { buildSyncPlan, type SyncPlan } from "./plan.ts";
import { assignUniqueSlugs, slugify } from "./slugify.ts";
import { buildUpdaterPlugin, type InjectedPlugin } from "./updater.ts";

/** The slice of the Notion client the sync depends on. */
export interface PluginSource {
  plugins: {
    listAll(): Promise<Plugin[]>;
    files(args: { plugin_id: string }): Promise<PluginFiles>;
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
  source: PluginSource;
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
 * The skill directories a plugin currently has in the target, sorted. Only dirs
 * holding a SKILL.md count — that single rule is what makes a hand-deleted
 * SKILL.md, a hand-deleted skill dir, and a hand-added one all show up as a
 * marker mismatch, and therefore heal.
 */
function existingSkillDirs(
  existing: Iterable<string>,
  pluginsDir: string,
  slug: string,
): string[] {
  const prefix = `${pluginDir(pluginsDir, slug)}/skills/`;
  const dirs: string[] = [];
  for (const path of existing) {
    if (!path.startsWith(prefix) || !path.endsWith("/SKILL.md")) continue;
    const rest = path.slice(prefix.length, -"/SKILL.md".length);
    if (rest && !rest.includes("/")) dirs.push(rest);
  }
  return dirs.sort();
}

/**
 * Resolve one plugin, downloading its archive only if the target is out of date.
 *
 * The archive is the only source of a plugin's skills, so change detection has
 * to happen before we know what's inside: rebuild the marker from the target's
 * own skill directories and compare content ids against the marker already
 * there. Both sides are in memory, so a no-op run costs one list call and
 * nothing else — reading markers back would be a GET per plugin, which on a
 * workspace with hundreds of them is the entire cost of doing nothing.
 */
async function resolvePlugin(args: {
  apiPlugin: Plugin;
  slug: string;
  source: PluginSource;
  /** Target path -> content id, for the whole base state. */
  existing: Map<string, string>;
  contentId: (content: FileContent) => string;
  pluginsDir: string;
  meta: NotionSourceMeta;
  log?: (message: string) => void;
}): Promise<PluginInput> {
  const { apiPlugin, slug, source, existing, contentId, pluginsDir, meta } = args;
  const log = args.log ?? (() => {});

  const plugin: PluginInput = {
    pluginId: apiPlugin.id,
    name: apiPlugin.name,
    slug,
    description: apiPlugin.description || MARKETPLACE_SEED.description,
    // 19 of dev's plugins come back with no name at all, and every client
    // rejects a blank `author.name`.
    author: apiPlugin.name || MARKETPLACE_SEED.owner.name,
    versionId: apiPlugin.version_id,
    skills: existingSkillDirs(existing.keys(), pluginsDir, slug),
  };

  if (
    plugin.skills.length > 0 &&
    existing.get(markerPath(pluginsDir, slug)) === contentId(buildSyncMarker(plugin, meta))
  ) {
    return plugin; // retained: no archive fetched, directory left alone
  }

  let archive: PluginFiles;
  try {
    archive = await source.plugins.files({ plugin_id: apiPlugin.id });
  } catch (err) {
    // The listing and the archive route can disagree: a plugin the list reports
    // may 404 as `directory_not_found` ("not shared by the connected
    // workspace"). One of those must not discard a whole run's work — on a
    // workspace with hundreds of plugins that is tens of minutes of serial
    // fetching. Retain instead: keep whatever the repo already has, publish no
    // change, and retry next run. Deliberately NOT "skip", which would leave the
    // plugin with no skills and prune its directory — turning a transient error
    // into deleted content. A plugin genuinely revoked disappears from the
    // listing, and that is what prunes it.
    log(`  ⚠ ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    log(`  ⚠ ${slug}: kept as-is; will retry next run.`);
    plugin.failed = true;
    return plugin;
  }

  plugin.files = archive.files;
  plugin.skills = archive.skills;

  log(`  ↓ ${slug}: ${archive.skills.length} skill(s)`);
  for (const entry of archive.skipped) {
    log(`  ⚠ ${slug}: skipped unsafe archive entry "${entry}".`);
  }
  for (const zip of archive.expandedZips) log(`  + ${slug}: expanded ${zip} in place.`);
  for (const dir of archive.invalid) {
    log(`  ⚠ ${slug}: skill "${dir}" has no SKILL.md; not published.`);
  }
  if (archive.skills.length === 0) log(`  ⚠ ${slug}: archive holds no skills; not published.`);

  return plugin;
}

/**
 * The name a plugin's directory is slugified from.
 *
 * `slugify` is ASCII-only, so it flattens a fully non-Latin name (Japanese
 * titles, for instance) to the empty string — as does a plugin the API reports
 * with no name at all. 26 of the dev workspace's 420 plugins hit this. Falling
 * back to the bare `pluginSlug` would leave `assignUniqueSlugs` to separate them
 * by *position* (`skills-2`, `skills-3`, …), which is not stable: delete one
 * plugin and every later one shifts to a different directory, so the next sync
 * rewrites and prunes subtrees that never actually changed.
 *
 * Suffixing the plugin's own id makes the directory a function of identity
 * instead of ordering. Ugly, but stable, unique, and traceable back to Notion.
 *
 * Use the id's TAIL. Notion ids are not random across their whole length — the
 * leading bytes look time-ordered, so a prefix has very little entropy: across
 * dev's 420 plugins the first 8 hex characters collide 149 times (one prefix is
 * shared by 16 plugins), which would put us straight back on positional
 * suffixes. The last 12 are unique for all 420 with room to spare.
 */
function fallbackName(plugin: Plugin, pluginSlug: string): string {
  if (slugify(plugin.name)) return plugin.name;
  return `${pluginSlug}-${plugin.id.replace(/-/g, "").slice(-12)}`;
}

/** Long plugin lists make an unreadable commit message; name some, count the rest. */
function summarize(slugs: string[], limit = 20): string {
  if (slugs.length === 0) return "(none)";
  if (slugs.length <= limit) return slugs.join(", ");
  return `${slugs.slice(0, limit).join(", ")}, +${slugs.length - limit} more`;
}

function commitMessage(plan: SyncPlan, env: NotionEnv): string {
  const lines = [
    `notion-skills sync: ${plan.pluginSlugs.length} plugin(s), ${plan.skillCount} skill(s)` +
      ` [~${plan.changes.write.length} files, -${plan.changes.delete.length}]`,
    "",
    `Synced from the Notion plugins API (${env}).`,
    `Plugins: ${summarize(plan.pluginSlugs)}`,
  ];
  if (plan.prunedSlugs.length) lines.push(`Pruned: ${summarize(plan.prunedSlugs)}`);
  return lines.join("\n");
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const { source, target, settings } = opts;
  const log = opts.log ?? ((m: string) => console.log(m));

  // 1. Read the target's current state.
  const base = await target.readState();

  // Merge into each client's existing manifest rather than clobbering the
  // repo's own identity keys. Missing files are seeded fresh.
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

  // 2. Read the workspace's plugins. Skill counts aren't in the listing — they
  // only exist inside an archive — so they're reported by the plan instead.
  const apiPlugins = await source.plugins.listAll();
  const slugs = assignUniqueSlugs(apiPlugins, (p) => fallbackName(p, settings.pluginSlug));
  log(
    `Notion: ${apiPlugins.length} plugin(s): ` +
      summarize(apiPlugins.map((p) => slugs.get(p)!), 40),
  );
  if (apiPlugins.length === 0) {
    log(
      "  No plugins visible to this token. Check that the Notion connection has " +
        "access to your skills, or add a skill in Notion.",
    );
  }

  const meta: NotionSourceMeta = {
    env: settings.notionEnv,
    databaseId: settings.skillsDatabaseId,
    skillsDataSourceId: settings.skillsDataSourceId,
  };

  const plugins: PluginInput[] = [];
  for (const apiPlugin of apiPlugins) {
    plugins.push(
      await resolvePlugin({
        apiPlugin,
        slug: slugs.get(apiPlugin)!,
        source,
        existing: base.files,
        contentId: (c) => target.contentId(c),
        pluginsDir: settings.pluginsDir,
        meta,
        log,
      }),
    );
  }

  // Tolerating a per-plugin failure must not tolerate a broken workspace. If
  // every plugin that needed fetching failed, the problem is systemic (auth, the
  // feature gate, the archive host) and a "successful" no-op sync would hide it.
  const failed = plugins.filter((p) => p.failed);
  if (failed.length > 0) {
    log(`\n  ⚠ ${failed.length} of ${plugins.length} plugin(s) could not be fetched.`);
    if (failed.length === plugins.length) {
      throw new Error(
        `Every plugin failed to fetch (${failed.length}). This is not a per-plugin ` +
          `problem — check the token's access, the 'public_api_skills_plugins' gate, ` +
          `and that the signed archive host is reachable.`,
      );
    }
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
    plugins,
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
  log(`  plugins        : ${summarize(plan.pluginSlugs, 40)}`);
  log(`  skills         : ${plan.skillCount}`);
  if (plan.retainedPlugins.length) {
    log(`  unchanged      : ${summarize(plan.retainedPlugins, 40)}`);
  }
  if (plan.injectedSlugs.length) log(`  injected       : ${plan.injectedSlugs.join(", ")}`);
  log(`  files changed  : ${plan.changes.write.length}`);
  log(`  files unchanged: ${plan.changes.unchanged}`);
  log(`  files deleted  : ${plan.changes.delete.length}`);
  if (plan.prunedSlugs.length) log(`  pruned plugins : ${summarize(plan.prunedSlugs, 40)}`);
  for (const c of plan.changes.write) log(`    ~ ${c.path}`);
  for (const d of plan.changes.delete) log(`    - ${d}`);
}
