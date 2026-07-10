import { createHash } from "node:crypto";
import { stringify as yamlStringify } from "yaml";

// --- Strip the YAML frontmatter block that `ntn pages get` prepends ----------
// `ntn pages get` returns:  ---\n<props>\n---\n\n<body>
// We want only <body>; SKILL.md gets its own frontmatter.
export function stripLeadingFrontmatter(markdown: string): string {
  const m = markdown.match(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = m ? markdown.slice(m[0].length) : markdown;
  return body.replace(/^\s+/, "").replace(/\s+$/, "");
}

// --- Description fallback -----------------------------------------------------
// SKILL.md's description drives agent routing, so it must be non-empty. When the
// Notion "Description" property is blank, derive one from the first real
// paragraph of the body.
export interface ResolvedDescription {
  description: string;
  fallbackUsed: boolean;
}

export function deriveDescription(
  rawDescription: string,
  body: string,
  maxLen = 220,
): ResolvedDescription {
  const desc = rawDescription.trim();
  if (desc) return { description: desc, fallbackUsed: false };

  const trunc = (s: string) =>
    s.length > maxLen ? s.slice(0, maxLen - 1).trimEnd() + "…" : s;

  // Prefer the first real prose line; fall back to a heading only if that's all
  // the body has.
  let firstAny = "";
  for (const line of body.split(/\r?\n/)) {
    const isHeading = /^#{1,6}\s+/.test(line.trim());
    const cleaned = line
      .replace(/^#{1,6}\s+/, "") // headings
      .replace(/^[-*+]\s+/, "") // bullets
      .replace(/^\d+\.\s+/, "") // numbered
      .replace(/[*_`>]/g, "") // inline markdown
      .trim();
    if (!cleaned) continue;
    if (!firstAny) firstAny = cleaned;
    if (!isHeading) return { description: trunc(cleaned), fallbackUsed: true };
  }
  return { description: firstAny ? trunc(firstAny) : "", fallbackUsed: true };
}

// --- Content hash (drives idempotency of the marker file) --------------------
export function contentHash(parts: { name: string; description: string; body: string }): string {
  const h = createHash("sha256");
  h.update(parts.name);
  h.update("\0");
  h.update(parts.description);
  h.update("\0");
  h.update(parts.body);
  return "sha256:" + h.digest("hex");
}

// --- File builders -----------------------------------------------------------
export interface SkillInput {
  pageId: string;
  name: string; // human name from Notion
  slug: string;
  description: string; // already resolved (fallback applied)
  body: string;
  createdBy: string;
  /** The plugin this skill belongs to (defaults to slug if not specified). */
  pluginSlug: string;
}

export interface NotionSourceMeta {
  env: string;
  databaseId: string;
  skillsDataSourceId: string;
}

export interface MarketplaceEntry {
  name: string;
  source: string;
  description: string;
}

export interface CodexMarketplaceEntry {
  name: string;
  source: {
    source: "local";
    path: string;
  };
  policy: {
    installation: "AVAILABLE";
    authentication: "ON_INSTALL";
  };
  category: string;
}

export interface MarketplaceBase<TEntry extends { name: string }> {
  name?: string;
  plugins: TEntry[];
  [key: string]: unknown;
}

export interface Marketplace extends MarketplaceBase<MarketplaceEntry> {
  name?: string;
  owner?: unknown;
  description?: string;
}

export interface CodexMarketplace extends MarketplaceBase<CodexMarketplaceEntry> {
  interface?: {
    displayName?: string;
    [key: string]: unknown;
  };
}

const json = (obj: unknown): string => JSON.stringify(obj, null, 2) + "\n";

export function buildSkillMarkdown(skill: SkillInput): string {
  const frontmatter = yamlStringify({ description: skill.description }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${skill.body}\n`;
}

export function buildPluginJson(skill: SkillInput): string {
  return json({
    name: skill.pluginSlug,
    version: "1.0.0",
    description: skill.description,
    author: { name: skill.createdBy || "Cowork Skills" },
  });
}

// The back-reference Cowork clients use to know where a skill came from (and to
// write changes back to Notion later). Also marks the plugin as managed by this
// sync so pruning never touches hand-authored plugins. Intentionally excludes
// volatile fields (e.g. last-edited time) so it only changes when content does.
export function buildSyncMarker(skill: SkillInput, meta: NotionSourceMeta): string {
  const pageIdNoDashes = skill.pageId.replace(/-/g, "");
  const host = meta.env === "prod" ? "www.notion.so" : `app.${meta.env}.notion.com`;
  return json({
    source: "notion",
    syncedBy: "notion-skills-github-sync",
    notion: {
      env: meta.env,
      databaseId: meta.databaseId || undefined,
      skillsDataSourceId: meta.skillsDataSourceId,
      pageId: skill.pageId,
      url: `https://${host}/p/${pageIdNoDashes}`,
    },
    skill: { slug: skill.slug, name: skill.name.trim() },
    contentHash: contentHash({
      name: skill.name.trim(),
      description: skill.description,
      body: skill.body,
    }),
  });
}

export const MARKER_FILENAME = ".notion-sync.json";

// Repo-relative paths for one skill within a plugin.
// pluginSlug = the containing plugin directory; skillSlug = the skill's own identifier.
export function pluginPaths(pluginsDir: string, pluginSlug: string, skillSlug: string) {
  const root = `${pluginsDir}/${pluginSlug}`;
  const skillDir = `${root}/skills/${skillSlug}`;
  return {
    root,
    claudePluginJson: `${root}/.claude-plugin/plugin.json`,
    codexPluginJson: `${root}/.codex-plugin/plugin.json`,
    skillMd: `${skillDir}/SKILL.md`,
    marker: `${skillDir}/${MARKER_FILENAME}`,
  };
}

// All files for one skill within its plugin, keyed by repo-relative path.
// Note: plugin.json is returned for each skill; callers that group multiple
// skills into one plugin should de-duplicate the plugin.json file (last wins).
export function buildPluginFiles(
  skill: SkillInput,
  pluginsDir: string,
  meta: NotionSourceMeta,
): Record<string, string> {
  const p = pluginPaths(pluginsDir, skill.pluginSlug, skill.slug);
  const pluginJson = buildPluginJson(skill);
  return {
    [p.claudePluginJson]: pluginJson,
    [p.codexPluginJson]: pluginJson,
    [p.skillMd]: buildSkillMarkdown(skill),
    [p.marker]: buildSyncMarker(skill, meta),
  };
}

export function marketplaceEntry(skill: SkillInput, pluginsDir: string): MarketplaceEntry {
  return {
    name: skill.pluginSlug,
    source: `./${pluginsDir}/${skill.pluginSlug}`,
    description: skill.description,
  };
}

export function codexMarketplaceEntry(
  skill: SkillInput,
  pluginsDir: string,
): CodexMarketplaceEntry {
  return {
    name: skill.pluginSlug,
    source: {
      source: "local",
      path: `./${pluginsDir}/${skill.pluginSlug}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };
}

// Merge desired managed entries into an existing marketplace, removing entries
// for any slug we control that's no longer desired (prune), and preserving
// hand-authored (non-managed) entries untouched.
export function mergeMarketplace(
  existing: Marketplace,
  desiredEntries: MarketplaceEntry[],
  controlledSlugs: Set<string>,
): Marketplace {
  const preserved = (existing.plugins ?? []).filter((p) => !controlledSlugs.has(p.name));
  const sortedDesired = [...desiredEntries].sort((a, b) => a.name.localeCompare(b.name));
  return { ...existing, plugins: [...preserved, ...sortedDesired] };
}

export function mergeCodexMarketplace(
  existing: CodexMarketplace,
  desiredEntries: CodexMarketplaceEntry[],
  controlledSlugs: Set<string>,
): CodexMarketplace {
  const preserved = (existing.plugins ?? []).filter((p) => !controlledSlugs.has(p.name));
  const sortedDesired = [...desiredEntries].sort((a, b) => a.name.localeCompare(b.name));
  return { ...existing, plugins: [...preserved, ...sortedDesired] };
}
