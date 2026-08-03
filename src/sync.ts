import type { Config } from "./config.ts";
import {
  NotionSkillsApi,
  type SkillDirectorySummary,
  type SkillsPlugin,
} from "./notion/skills-api.ts";
import { assignUniqueSlugs } from "./slugify.ts";
import {
  buildSyncMarker,
  pluginPaths,
  type NotionSourceMeta,
  type PluginInfo,
  type SkillInput,
} from "./convert.ts";
import {
  CLIENTS,
  type ClientId,
  type MarketplaceManifest,
  type MarketplaceSeed,
} from "./clients.ts";
import { buildSyncPlan, type PluginGroup, type SyncPlan } from "./plan.ts";
import { gitBlobSha, hasChanges, toBytes, type FileContent } from "./diff.ts";
import { GitHubRepo, isInlineableText, toTreeEntries } from "./github.ts";
import { buildUpdaterPlugin, type InjectedPlugin } from "./updater.ts";
import { downloadFile, extractSkillArchive } from "./files.ts";

export interface SyncOptions {
  dryRun?: boolean;
  /** Injectable for tests. */
  api?: SkillsApiLike;
}

/** The slice of the Notion skills API the sync depends on. */
export interface SkillsApiLike {
  listPlugins(): Promise<SkillsPlugin[]>;
  getDirectoryArchive(id: string): Promise<{ url: string }>;
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

/**
 * Resolve one plugin's skills into `SkillInput`s.
 *
 * Slugs are made unique within the plugin, not across the run: two plugins may
 * each hold a skill with the same title, and they land in separate directories.
 *
 * The archive for a directory is only downloaded when its `version_id` differs
 * from what the repo already has. Building that archive is real server-side
 * work (render the page, fetch every attachment, upload a tarball), so on an
 * hourly schedule where nothing changed this makes the whole run a handful of
 * cheap GETs.
 */
export async function resolveSkills(args: {
  directories: SkillDirectorySummary[];
  plugin: PluginInfo;
  api: SkillsApiLike;
  /** Repo path -> git blob sha, for the whole base tree. */
  existing: Map<string, string>;
  pluginsDir: string;
  meta: NotionSourceMeta;
}): Promise<SkillInput[]> {
  const { directories, plugin, api, existing, pluginsDir, meta } = args;

  const slugs = assignUniqueSlugs(directories, (d) => d.name);
  const skills: SkillInput[] = [];

  for (const dir of directories) {
    const skill: SkillInput = {
      directoryId: dir.id,
      name: dir.name,
      slug: slugs.get(dir)!,
      description: dir.description,
      versionId: dir.version_id,
    };

    // The marker we'd write embeds version_id (plus slug, name, and the Notion
    // ids). A byte-identical marker already in the repo therefore means this
    // skill dir is fully up to date — skip the download and leave it alone.
    // Require SKILL.md to still be there too, so a hand-deleted file heals
    // instead of being retained forever behind a matching marker.
    //
    // The comparison is on git blob shas, not file contents: `existing` is the
    // whole base tree, already fetched in one request, so this costs nothing.
    // Reading each marker back instead would be one GET per skill — the single
    // biggest cost of an otherwise no-op hourly run.
    const paths = pluginPaths(pluginsDir, plugin.slug, skill.slug);
    if (
      existing.has(`${paths.skillDir}/SKILL.md`) &&
      existing.get(paths.marker) === gitBlobSha(buildSyncMarker(skill, meta))
    ) {
      skills.push(skill); // no `files` -> retained as-is
      continue;
    }

    const { url } = await api.getDirectoryArchive(dir.id);
    const { files, skipped, expandedZip } = extractSkillArchive(await downloadFile(url));
    for (const s of skipped) {
      console.warn(`  ⚠ ${skill.slug}: skipped unsafe archive entry "${s}".`);
    }
    if (expandedZip) {
      console.log(`  + ${skill.slug}: expanded ${expandedZip} in place.`);
    }
    if (!files["SKILL.md"]) {
      console.warn(`  ⚠ ${skill.slug}: archive contained no SKILL.md.`);
    }
    skill.files = files;
    skills.push(skill);
  }

  return skills;
}

function commitMessage(plan: SyncPlan, env: string): string {
  const lines = [
    `notion-skills sync: ${plan.skillSlugs.length} skill(s)` +
      ` [~${plan.changes.create.length} files, -${plan.changes.delete.length}]`,
    "",
    `Synced from the Notion skills API (${env}).`,
    `Skills: ${plan.skillSlugs.join(", ") || "(none)"}`,
  ];
  if (plan.prunedSlugs.length) lines.push(`Pruned: ${plan.prunedSlugs.join(", ")}`);
  return lines.join("\n");
}

export async function runSync(config: Config, opts: SyncOptions = {}): Promise<SyncResult> {
  if (!opts.api && !config.notionToken) {
    throw new Error(
      "Missing NOTION_API_TOKEN. The sync reads the Notion skills API directly over HTTPS; " +
        "set NOTION_API_TOKEN in the environment (or .env for local runs).",
    );
  }
  const api = opts.api ?? new NotionSkillsApi(config.notionEnv, config.notionToken!);

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

  // The API reports one plugin per skills grouping in the workspace (per-team
  // plugins plus Notion's own "Notion Workspace Skills"), each holding the
  // skills the token can read. Every one of them becomes its own plugin
  // directory, named after the plugin and made unique across the run.
  const apiPlugins = await api.listPlugins();
  const pluginSlugs = assignUniqueSlugs(apiPlugins, (p) => p.name || config.pluginSlug);
  const totalSkills = apiPlugins.reduce((n, p) => n + (p.skills?.length ?? 0), 0);
  console.log(
    `Notion: ${totalSkills} skill(s) across ${apiPlugins.length} plugin(s): ` +
      (apiPlugins.map((p) => `${pluginSlugs.get(p)} (${p.skills?.length ?? 0})`).join(", ") ||
        "(none)"),
  );
  if (totalSkills === 0) {
    console.warn(
      "  No skills visible to this token. Check that the Notion connection has " +
        "access to your skills, or add a skill in Notion.",
    );
  }

  const meta: NotionSourceMeta = {
    env: config.notionEnv,
    databaseId: config.skillsDatabaseId,
    skillsDataSourceId: config.skillsDataSourceId,
  };

  const groups: PluginGroup[] = [];
  for (const apiPlugin of apiPlugins) {
    const plugin: PluginInfo = {
      slug: pluginSlugs.get(apiPlugin)!,
      description: apiPlugin.description || MARKETPLACE_SEED.description,
      author: apiPlugin.name || MARKETPLACE_SEED.owner.name,
    };
    const skills = await resolveSkills({
      directories: apiPlugin.skills ?? [],
      plugin,
      api,
      existing,
      pluginsDir: config.pluginsDir,
      meta,
    });
    groups.push({ plugin, skills });
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
    plugins: groups,
    existing,
    existingMarketplaces,
    pluginsDir: config.pluginsDir,
    meta,
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

  // Write the changed files, then one atomic tree+commit.
  //
  // Text rides inline in the tree request, which is what keeps a large sync
  // inside GitHub's content-creating limits (80/min, 500/hour): a cold run
  // rewriting every skill would otherwise need one POST per file and simply
  // cannot fit in an hour. Only binary files still need their own blob.
  const inline: Array<{ path: string; content: string }> = [];
  const binary: Array<{ path: string; content: FileContent }> = [];
  for (const f of plan.changes.create) {
    if (isInlineableText(f.content)) inline.push({ path: f.path, content: toBytes(f.content).toString("utf8") });
    else binary.push(f);
  }
  if (binary.length) {
    console.log(`  Uploading ${binary.length} binary file(s) as blobs; ${inline.length} inline.`);
  }

  const uploaded: Array<{ path: string; sha: string }> = [];
  for (const f of binary) {
    uploaded.push({ path: f.path, sha: await gh.createBlob(f.content) });
  }
  const entries = toTreeEntries({ inline, uploaded, deletePaths: plan.changes.delete });
  const newTreeSha = await gh.buildTree(baseTreeSha, entries);

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
  console.log(`  skills         : ${plan.skillSlugs.join(", ") || "(none)"}`);
  if (plan.retainedSkills.length) {
    console.log(`  unchanged      : ${plan.retainedSkills.join(", ")}`);
  }
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
