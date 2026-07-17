import type { Config } from "./config.ts";
import { NtnNotionClient } from "./notion/ntn-adapter.ts";
import type { NotionClient, NotionFileRef } from "./notion/types.ts";
import { assignUniqueSlugs, slugify } from "./slugify.ts";
import { deriveDescription, type NotionSourceMeta, type SkillInput } from "./convert.ts";
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
import { downloadFile, pickSkillZip, unzipSkillArchive } from "./files.ts";

export interface SyncOptions {
  dryRun?: boolean;
  notionClient?: NotionClient; // injectable for tests
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

async function resolveSkills(
  notion: NotionClient,
  config: Config,
): Promise<SkillInput[]> {
  const pages = await notion.listSkillPages();
  const ready = pages.filter((p) => p.published);

  console.log(
    `Notion: ${pages.length} row(s), ${ready.length} published (ready to sync).`,
  );
  if (ready.length === 0) {
    console.warn(
      "  No published skills. Run `setup` to add + check the Published property, " +
        "or check the box on rows you want to sync.",
    );
  }

  const slugs = assignUniqueSlugs(ready, (p) => p.name);
  const skills: SkillInput[] = [];

  for (const page of ready) {
    const slug = slugs.get(page)!;
    const body = await notion.getPageBodyMarkdown(page.pageId);
    const { description, fallbackUsed } = deriveDescription(page.description, body);

    if (!body.trim()) {
      console.warn(`  ⚠ ${slug}: page body is empty — skill will have no instructions.`);
    }
    if (fallbackUsed) {
      console.warn(
        `  ⚠ ${slug}: Description property is empty — derived one from the body. ` +
          `Fill in Description in Notion for better agent routing.`,
      );
    }

    // Determine pluginSlug: use the Plugins property if set, otherwise default to "skills".
    const pluginSlug = page.plugin ? slugify(page.plugin) || "skills" : "skills";

    // Optional zip attachment on the Files property: unpack its contents into
    // the skill dir (Notion's SKILL.md is layered on top downstream).
    const extraFiles = await resolveExtraFiles(page.files, slug);

    skills.push({
      pageId: page.pageId,
      name: page.name,
      slug,
      description,
      body,
      createdBy: page.createdBy,
      pluginSlug,
      extraFiles,
    });
  }
  return skills;
}

// Download + unpack a skill's zip attachment (if any) into skill-dir-relative
// files. Failures are non-fatal: we warn and sync the skill without extras
// rather than aborting the whole run.
async function resolveExtraFiles(
  files: NotionFileRef[] | undefined,
  slug: string,
): Promise<Record<string, Uint8Array> | undefined> {
  const zip = pickSkillZip(files);
  if (!zip) return undefined;

  try {
    const bytes = await downloadFile(zip.url);
    const { files: unpacked, skipped } = unzipSkillArchive(bytes);
    for (const s of skipped) {
      console.warn(`  ⚠ ${slug}: skipped unsafe zip entry "${s}".`);
    }
    const count = Object.keys(unpacked).length;
    if (count > 0) {
      console.log(`  + ${slug}: unpacked ${count} file(s) from ${zip.name}.`);
    } else {
      console.warn(`  ⚠ ${slug}: ${zip.name} contained no usable files.`);
    }
    return count > 0 ? unpacked : undefined;
  } catch (err) {
    console.warn(
      `  ⚠ ${slug}: failed to unpack ${zip.name} (${err instanceof Error ? err.message : String(err)}) — syncing without extra files.`,
    );
    return undefined;
  }
}

function commitMessage(plan: SyncPlan, env: string): string {
  const created = plan.changes.create
    .filter((c) => c.path.endsWith("SKILL.md"))
    .length;
  const lines = [
    `notion-skills sync: ${plan.desiredSlugs.length} skill(s)` +
      ` [~${plan.changes.create.length} files, -${plan.changes.delete.length}]`,
    "",
    `Synced from Notion "Cowork Skills" (${env}).`,
    `Skills: ${plan.desiredSlugs.join(", ") || "(none)"}`,
  ];
  if (plan.prunedSlugs.length) lines.push(`Pruned: ${plan.prunedSlugs.join(", ")}`);
  void created;
  return lines.join("\n");
}

export async function runSync(config: Config, opts: SyncOptions = {}): Promise<SyncResult> {
  const notion =
    opts.notionClient ?? new NtnNotionClient(config.notionEnv, config.skillsDataSourceId);

  const skills = await resolveSkills(notion, config);

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

  const meta: NotionSourceMeta = {
    env: config.notionEnv,
    databaseId: config.skillsDatabaseId,
    skillsDataSourceId: config.skillsDataSourceId,
  };
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
  const skillCreates = plan.changes.create.filter((c) => c.path.endsWith("SKILL.md"));
  console.log(`\nPlan (base: ${baseRef} -> branch: ${branch}):`);
  console.log(`  skills to sync : ${plan.desiredSlugs.join(", ") || "(none)"}`);
  if (plan.injectedSlugs.length) {
    console.log(`  injected       : ${plan.injectedSlugs.join(", ")}`);
  }
  console.log(`  files changed  : ${plan.changes.create.length}`);
  console.log(`  files unchanged: ${plan.changes.unchanged}`);
  console.log(`  files deleted  : ${plan.changes.delete.length}`);
  if (plan.prunedSlugs.length) console.log(`  pruned skills  : ${plan.prunedSlugs.join(", ")}`);
  void skillCreates;
  for (const c of plan.changes.create) console.log(`    ~ ${c.path}`);
  for (const d of plan.changes.delete) console.log(`    - ${d}`);
}
