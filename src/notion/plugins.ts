// The Skills/Plugins Public API. `list` is cheap; `retrieve` is expensive
// server-side (render + attachment fetch + upload of a whole plugin), so use a
// skill's `version_id` to skip it.
//
// No per-row publish flag: the API returns every live plugin the token can
// read, so access to the connection is what governs what a consumer sees.
//
// The route moved with the Agent Plugins 1.0 standard (2026-08): the per-skill
// `/v1/ai/skills/:id` archive endpoint is gone (it now 400s with
// `invalid_request_url`), replaced by `/v1/ai/plugins/:id`, which returns the
// signed `.tar.gz` for a *whole plugin* laid out to that standard.

import {
  downloadArchive,
  extractPluginArchive,
  SKILL_MD,
  type SkillFiles,
} from "./archive.ts";
import {
  collectPaginated,
  NotionApiError,
  NotionErrorCode,
  type NotionHttp,
  type PaginatedArgs,
  type PaginatedList,
} from "./http.ts";

export interface Skill {
  id: string;
  /** Page title, kebab-cased by Notion. */
  name: string;
  description: string;
  updated_at: string;
  /** Opaque hash; compare for equality to detect changes. */
  version_id: string;
}

/** A skills grouping — a team's plugin, or Notion's built-in one. */
export interface SkillsPlugin {
  id: string;
  name: string;
  description: string;
  version_id: string;
  skills: Skill[];
}

/** What `/v1/ai/plugins/:id` returns: a signed URL to the plugin's archive. */
export interface PluginArchiveRef {
  id: string;
  version_id: string;
  /** Short-lived signed URL for the whole plugin's .tar.gz. */
  url: string;
}

/** Identifies one skill inside a plugin archive, so files can be routed to it. */
export interface PluginSkillRef {
  id: string;
  /** The directory name this skill should land in (its unique slug). */
  slug: string;
  /** The API's kebab-cased name, used as a matching fallback. */
  name: string;
}

/** A plugin archive, split back out into the skills that asked for it. */
export interface ResolvedPluginFiles {
  /** Files for each requested skill, keyed by that skill's slug. */
  bySlug: Record<string, SkillFiles>;
  /** `skills/<dir>/` present in the archive but matching no requested skill. */
  unmatchedDirs: string[];
  /** Plugin-root files outside `skills/` (plugin.json, mcp.json, …). */
  extras: Record<string, Uint8Array>;
  /** Unsafe archive entries dropped across the whole plugin. */
  skipped: string[];
}

export type ListPluginsArgs = PaginatedArgs;
export type ListPluginsResponse = PaginatedList<SkillsPlugin>;

export const PLUGINS_PATH = "/v1/ai/plugins";

export function pluginResources(http: NotionHttp) {
  const plugins = {
    list: (args: ListPluginsArgs = {}): Promise<ListPluginsResponse> =>
      request<ListPluginsResponse>(http, {
        path: PLUGINS_PATH,
        query: { start_cursor: args.start_cursor, page_size: args.page_size },
      }),

    /** The server ignores `page_size` but does emit a cursor — so follow it. */
    listAll: (args: ListPluginsArgs = {}): Promise<SkillsPlugin[]> =>
      collectPaginated<ListPluginsArgs, SkillsPlugin>((a) => plugins.list(a), args),

    retrieve: ({ plugin_id }: { plugin_id: string }): Promise<PluginArchiveRef> =>
      request<PluginArchiveRef>(http, {
        path: `${PLUGINS_PATH}/${encodeURIComponent(plugin_id)}`,
      }),

    /**
     * Download a plugin's archive once and split it back into per-skill files.
     * A plugin now travels as a single archive, so one GET covers every skill
     * in it — routed to each skill by its `skills/<dir>/` name.
     */
    files: async ({
      plugin_id,
      skills,
    }: {
      plugin_id: string;
      skills: PluginSkillRef[];
    }): Promise<ResolvedPluginFiles> => {
      const { url } = await plugins.retrieve({ plugin_id });
      const archive = extractPluginArchive(await downloadArchive(url, (u) => http.fetchUrl(u)));
      return routeSkills(archive.skills, skills, archive.extras, archive.skipped);
    },
  };

  return { plugins };
}

// Non-alphanumeric-collapsing normalization, so a `skills/<dir>/` name matches a
// skill's slug even if one side capitalizes or punctuates differently. Mirrors
// `src/sync/slugify.ts` on purpose — `src/notion/` may not import from `src/sync/`.
function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Match each requested skill to a `skills/<dir>/` in the archive, exact slug
// first, then the API name, then a normalized compare. Each dir is claimed by
// at most one skill so two skills can't share the same files.
function routeSkills(
  dirs: Record<string, SkillFiles>,
  skills: PluginSkillRef[],
  extras: Record<string, Uint8Array>,
  skipped: string[],
): ResolvedPluginFiles {
  const remaining = new Map(Object.entries(dirs));
  const bySlug: Record<string, SkillFiles> = {};

  for (const skill of skills) {
    let key: string | undefined;
    if (remaining.has(skill.slug)) key = skill.slug;
    else if (remaining.has(skill.name)) key = skill.name;
    else {
      const want = normalize(skill.slug);
      for (const dir of remaining.keys()) {
        if (normalize(dir) === want) {
          key = dir;
          break;
        }
      }
    }
    if (key === undefined) continue;
    bySlug[skill.slug] = remaining.get(key)!;
    remaining.delete(key);
  }

  return { bySlug, unmatchedDirs: [...remaining.keys()], extras, skipped };
}

export { SKILL_MD };

// A workspace without the plugins feature gate gets the same 403 as a token
// missing read access, so name both causes — the fixes differ entirely.
async function request<T>(
  http: NotionHttp,
  args: { path: string; query?: Record<string, string | number | undefined | null> },
): Promise<T> {
  try {
    return await http.request<T>(args);
  } catch (err) {
    if (!NotionApiError.is(err) || err.hint) throw err;
    if (err.status === 403 && err.code === NotionErrorCode.RestrictedResource) {
      throw err.withHint(
        `  This is either:\n` +
          `    - the 'public_api_skills_plugins' feature gate being off for this ` +
          `workspace (ask the Public API team to enable it), or\n` +
          `    - the access token lacking read content access to the plugins.`,
      );
    }
    if (err.status === 401) {
      throw err.withHint("  The Notion access token is missing or invalid.");
    }
    if (err.status === 400 && err.code === NotionErrorCode.InvalidRequestURL) {
      throw err.withHint(
        `  The Plugins API route was rejected outright. These endpoints moved with ` +
          `the Agent Plugins standard (per-skill /v1/ai/skills/:id became per-plugin ` +
          `/v1/ai/plugins/:id), so suspect a route rename before a permissions problem.`,
      );
    }
    throw err;
  }
}
