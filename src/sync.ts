import type { Config } from "./config.ts";
import {
  NtnAiPluginsApi,
  type AiPluginsApi,
} from "./notion/ai-api.ts";
import {
  CLIENTS,
  type ClientId,
  type MarketplaceManifest,
  type MarketplaceSeed,
} from "./clients.ts";
import { buildSyncPlan, type PluginInput, type SkillDirInput, type SyncPlan } from "./plan.ts";
import { hasChanges } from "./diff.ts";
import { GitHubRepo, toTreeEntries } from "./github.ts";
import { buildUpdaterPlugin, type InjectedPlugin } from "./updater.ts";
import { downloadFile, unzipSkillArchive } from "./files.ts";

export interface SyncOptions {
  dryRun?: boolean;
  aiApi?: AiPluginsApi; // injectable for tests
}

export interface SyncResult {
  committed: boolean;
  commitSha?: string;
  branch: string;
  plan: SyncPlan;
}

// Seed used to synthesize a fresh marketplace for any client whose manifest
// doesn't exist in the repo yet. Existing manifests are read and merged into.
const MARKETPLACE_SEED: MarketplaceSeed = {
  name: "skills",
  owner: { name: "Skills Team" },
  displayName: "Skills",
  description: "Skills synced from Notion.",
};

// Pull the plugin/skill set straight from the Notion AI API: the API groups
// skills by plugin and packages each skill directory into a zip, so all the sync
// does is download + unpack each archive. Download/unpack failures for a single
// skill are non-fatal — we warn and continue rather than aborting the whole run.
async function resolvePlugins(api: AiPluginsApi): Promise<PluginInput[]> {
  const plugins = await api.listPlugins();
  console.log(`Notion AI API: ${plugins.length} plugin(s).`);

  const out: PluginInput[] = [];
  for (const plugin of plugins) {
    const skillDirs: SkillDirInput[] = [];
    for (const dir of plugin.skillDirectories) {
      try {
        const archive = await api.getSkillArchive(dir.id);
        if (!archive.url) {
          console.warn(`  ⚠ ${plugin.name}/${dir.name}: no download URL returned — skipping.`);
          continue;
        }
        const bytes = await downloadFile(archive.url);
        const { files, skipped } = unzipSkillArchive(bytes, dir.name);
        for (const s of skipped) {
          console.warn(`  ⚠ ${plugin.name}/${dir.name}: skipped unsafe zip entry "${s}".`);
        }
        const count = Object.keys(files).length;
        if (count === 0) {
          console.warn(`  ⚠ ${plugin.name}/${dir.name}: archive contained no usable files.`);
          continue;
        }
        console.log(
          `  + ${plugin.name}/${dir.name}: ${count} file(s)` +
            (archive.versionId ? ` [${archive.versionId}]` : ""),
        );
        skillDirs.push({ name: dir.name, files });
      } catch (err) {
        console.warn(
          `  ⚠ ${plugin.name}/${dir.name}: failed to fetch (${err instanceof Error ? err.message : String(err)}) — skipping.`,
        );
      }
    }
    out.push({ name: plugin.name, description: plugin.description, skillDirs });
  }
  return out;
}

function commitMessage(plan: SyncPlan, env: string): string {
  const lines = [
    `notion-skills sync: ${plan.desiredSlugs.length} plugin(s)` +
      ` [~${plan.changes.create.length} files, -${plan.changes.delete.length}]`,
    "",
    `Synced from the Notion AI plugins API (${env}).`,
    `Plugins: ${plan.desiredSlugs.join(", ") || "(none)"}`,
  ];
  if (plan.prunedSlugs.length) lines.push(`Pruned: ${plan.prunedSlugs.join(", ")}`);
  return lines.join("\n");
}

export async function runSync(config: Config, opts: SyncOptions = {}): Promise<SyncResult> {
  const api = opts.aiApi ?? new NtnAiPluginsApi(config.notionEnv);

  const plugins = await resolvePlugins(api);

  const gh = new GitHubRepo(config.githubRepo, config.githubToken);
  const branch = config.githubBranch;

  // Read base state: the target branch if it exists, else the default branch.
  const branchHead = await gh.getBranchHead(branch);
  const branchExists = branchHead !== null;
  const defaultBranch = await gh.getDefaultBranch();
  const baseRef = branchExists ? branch : defaultBranch;
  const baseHead = branchHead ?? (await gh.getBranchHead(defaultBranch));
  if (!baseHead) throw new Error(`Could not resolve head commit for ${baseRef}.`);

  const baseTreeSha = await gh.getCommitTreeSha(baseHead);
  const treeFiles = await gh.getTreeFiles(baseTreeSha);
  const existing = new Map([...treeFiles].map(([p, v]) => [p, v.sha]));

  // Read each supported client's marketplace manifest (if present) so we merge
  // into it rather than clobbering hand-authored entries. Missing files are
  // seeded fresh.
  const existingMarketplaces: Partial<Record<ClientId, MarketplaceManifest>> = {};
  for (const client of CLIENTS) {
    const content = await gh.getFileContent(client.marketplacePath, baseRef);
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
        `Existing ${client.marketplacePath} on ${baseRef} is not valid JSON; refusing to overwrite.`,
      );
    }
  }

  const injected: InjectedPlugin[] = config.injectUpdater
    ? [
        buildUpdaterPlugin({
          pluginsDir: config.pluginsDir,
          slug: config.updaterSlug,
          env: config.notionEnv,
          skillsDataSourceId: config.skillsDataSourceId,
          changeRequestsDataSourceId: config.changeRequestsDataSourceId,
        }),
      ]
    : [];

  const plan = buildSyncPlan({
    plugins,
    existing,
    existingMarketplaces,
    pluginsDir: config.pluginsDir,
    injected,
  });

  reportPlan(plan, baseRef, branch);

  if (opts.dryRun) {
    console.log("\n(dry run — no changes pushed)");
    return { committed: false, branch, plan };
  }

  if (!hasChanges(plan.changes)) {
    console.log("\n✓ Up to date — no commit needed.");
    return { committed: false, branch, plan };
  }

  // Upload changed files as blobs, then one atomic tree+commit.
  const created: Array<{ path: string; sha: string }> = [];
  for (const f of plan.changes.create) {
    const sha = await gh.createBlob(f.content);
    created.push({ path: f.path, sha });
  }
  const entries = toTreeEntries(created, plan.changes.delete);
  const newTreeSha = await gh.createTree(baseTreeSha, entries);

  if (newTreeSha === baseTreeSha) {
    console.log("\n✓ Tree unchanged — no commit needed.");
    return { committed: false, branch, plan };
  }

  const commitSha = await gh.createCommit({
    message: commitMessage(plan, config.notionEnv),
    treeSha: newTreeSha,
    parents: [baseHead],
    authorName: config.authorName,
    authorEmail: config.authorEmail,
  });

  if (branchExists) await gh.updateBranch(branch, commitSha);
  else await gh.createBranch(branch, commitSha);

  console.log(`\n✓ Committed ${commitSha.slice(0, 7)} to ${branch}`);
  console.log(`  ${gh.webBranchUrl(branch)}`);
  return { committed: true, commitSha, branch, plan };
}

function reportPlan(plan: SyncPlan, baseRef: string, branch: string): void {
  console.log(`\nPlan (base: ${baseRef} -> branch: ${branch}):`);
  console.log(`  plugins to sync: ${plan.desiredSlugs.join(", ") || "(none)"}`);
  if (plan.injectedSlugs.length) {
    console.log(`  injected       : ${plan.injectedSlugs.join(", ")}`);
  }
  console.log(`  files changed  : ${plan.changes.create.length}`);
  console.log(`  files unchanged: ${plan.changes.unchanged}`);
  console.log(`  files deleted  : ${plan.changes.delete.length}`);
  if (plan.prunedSlugs.length) console.log(`  pruned plugins : ${plan.prunedSlugs.join(", ")}`);
  for (const c of plan.changes.create) console.log(`    ~ ${c.path}`);
  for (const d of plan.changes.delete) console.log(`    - ${d}`);
}
