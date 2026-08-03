import {
  buildPluginJson,
  marketplaceListing,
  type PluginMeta,
} from "./convert.ts";
import {
  CLIENTS,
  mergeMarketplace,
  pluginManifestPath,
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

// Default author name for a plugin's manifest when the API doesn't supply one.
const DEFAULT_AUTHOR = "Notion Skills";

// One skill directory, already downloaded + unpacked from the API's zip.
export interface SkillDirInput {
  /** Directory name placed under the plugin's `skills/` dir. */
  name: string;
  /** Skill-dir-relative POSIX path -> bytes (straight from the API archive). */
  files: Record<string, Uint8Array>;
}

// A plugin ready to be laid down in the repo: its metadata + its skill dirs.
export interface PluginInput {
  /** Plugin slug / directory name. */
  name: string;
  /** Plugin description (may be empty). */
  description: string;
  /** Best-effort author name for the plugin manifest. */
  author?: string;
  skillDirs: SkillDirInput[];
}

export interface SyncPlan {
  desiredFiles: Record<string, FileContent>;
  deletePaths: string[];
  desiredSlugs: string[]; // Notion-sourced plugins
  injectedSlugs: string[]; // tool-injected plugins (e.g. updater)
  prunedSlugs: string[];
  changes: TreeChanges;
  // One merged marketplace manifest per supported client, keyed by client id.
  marketplaces: Record<ClientId, MarketplaceManifest>;
  // Back-compat convenience: the Claude marketplace.
  marketplace: MarketplaceManifest;
}

export function buildSyncPlan(opts: {
  plugins: PluginInput[];
  existing: Map<string, string>; // repo path -> git blob sha
  // Existing marketplace manifests read from the repo, keyed by client id.
  // A missing entry is treated as an empty marketplace.
  existingMarketplaces: Partial<Record<ClientId, MarketplaceManifest>>;
  pluginsDir: string;
  injected?: InjectedPlugin[]; // synthetic plugins added by the tool (e.g. updater)
}): SyncPlan {
  const { plugins, existing, pluginsDir } = opts;
  const injected = opts.injected ?? [];

  const desiredFiles: Record<string, FileContent> = {};
  for (const plugin of plugins) {
    const root = `${pluginsDir}/${plugin.name}`;
    const meta: PluginMeta = {
      name: plugin.name,
      version: "1.0.0",
      description: plugin.description || plugin.name,
      author: { name: plugin.author?.trim() || DEFAULT_AUTHOR },
    };
    const manifest = buildPluginJson(meta);
    // One plugin.json per supported client (same content, different directory).
    for (const client of CLIENTS) desiredFiles[pluginManifestPath(client, root)] = manifest;
    // The skill directories are dropped in verbatim from the API's zips.
    for (const dir of plugin.skillDirs) {
      for (const [rel, bytes] of Object.entries(dir.files)) {
        desiredFiles[`${root}/skills/${dir.name}/${rel}`] = bytes;
      }
    }
  }
  // Injected plugins (e.g. the updater) are re-asserted on every sync.
  for (const inj of injected) Object.assign(desiredFiles, inj.files);

  const notionPluginSlugs = [...new Set(plugins.map((p) => p.name))];
  const injectedSlugs = injected.map((i) => i.slug);
  const desiredSlugs = [...notionPluginSlugs, ...injectedSlugs];

  // The Notion AI API is authoritative for the whole plugins tree, so the sync
  // fully owns everything under pluginsDir: any existing file there that this
  // run didn't (re)produce is stale and pruned. Injected plugins live in
  // desiredFiles, so they're never pruned. Files outside pluginsDir (e.g. the
  // client marketplace manifests) are never touched by this pass.
  const prefix = `${pluginsDir}/`;
  const deleteSet = new Set<string>();
  const existingPluginSlugs = new Set<string>();
  for (const path of existing.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash > 0) existingPluginSlugs.add(rest.slice(0, slash));
    if (desiredFiles[path] === undefined) deleteSet.add(path);
  }
  const prunedSlugs = [...existingPluginSlugs].filter((s) => !desiredSlugs.includes(s));
  const deletePaths = [...deleteSet];

  // Marketplace entries we control: every plugin dir that currently exists under
  // pluginsDir + this run's desired plugins. Entries pointing elsewhere
  // (hand-authored plugins outside pluginsDir) are preserved through the merge.
  const controlled = new Set([...existingPluginSlugs, ...desiredSlugs]);

  const seen = new Set<string>();
  const uniqueInputs: MarketplaceEntryInput[] = [
    ...plugins.map((p) => marketplaceListing({ name: p.name, description: p.description || p.name }, pluginsDir)),
    ...injected.map((i) => i.entry),
  ].filter((input) => {
    if (seen.has(input.name)) return false;
    seen.add(input.name);
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
    changes,
    marketplaces,
    marketplace: marketplaces.claude,
  };
}
