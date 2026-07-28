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
import { buildSyncPlan, type SyncPlan } from "./plan.ts";
import { hasChanges } from "./diff.ts";
import { GitHubRepo, toTreeEntries } from "./github.ts";
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

/** The slice of the GitHub client `resolveSkills` needs (for testing). */
export interface RepoReader {
  getFileContent(path: string, ref: string): Promise<string | null>;
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
 * Resolve every skill directory the API reports into a `SkillInput`.
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
  gh: RepoReader;
  baseRef: string;
  existing: Map<string, string>;
  pluginsDir: string;
  meta: NotionSourceMeta;
}): Promise<SkillInput[]> {
  const { directories, plugin, api, gh, baseRef, existing, pluginsDir, meta } = args;

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
    const paths = pluginPaths(pluginsDir, plugin.slug, skill.slug);
    if (existing.has(paths.marker) && existing.has(`${paths.skillDir}/SKILL.md`)) {
      const current = await gh.getFileContent(paths.marker, baseRef);
      if (current === buildSyncMarker(skill, meta)) {
        skills.push(skill); // no `files` -> retained as-is
        continue;
      }
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

  // The API returns one plugin ("Notion Workspace Skills") holding every skill
  // directory the token can read. We publish it under a stable local directory
  // name so the plugin's identity in the repo doesn't move if Notion renames it.
  const plugins = await api.listPlugins();
  const apiPlugin = plugins[0];
  const directories = apiPlugin?.skill_directories ?? [];
  console.log(
    `Notion: ${directories.length} skill director(ies) from ${apiPlugin?.name ?? "the skills API"}.`,
  );
  if (directories.length === 0) {
    console.warn(
      "  No skills visible to this token. Check that the Notion connection has " +
        "access to your skills, or add a skill in Notion.",
    );
  }

  const plugin: PluginInfo = {
    slug: config.pluginSlug,
    description: apiPlugin?.description || MARKETPLACE_SEED.description,
    author: apiPlugin?.name || "Notion Workspace Skills",
  };

  const meta: NotionSourceMeta = {
    env: config.notionEnv,
    databaseId: config.skillsDatabaseId,
    skillsDataSourceId: config.skillsDataSourceId,
  };

  const skills = await resolveSkills({
    directories,
    plugin,
    api,
    gh,
    baseRef,
    existing,
    pluginsDir: config.pluginsDir,
    meta,
  });

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
    skills,
    plugin,
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
