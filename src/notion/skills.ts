// The Skills Public API: the two endpoints that make a workspace's skills
// readable as directories of files.
//
//   GET /v1/ai/plugins
//     -> a paginated list of the workspace's skills plugins, each with the
//        skills in it ({ id, name, description, updated_at, version_id }).
//        `name` is the page title kebab-cased; `description` already has
//        Notion's own first-line fallback applied.
//
//   GET /v1/ai/skills/:id
//     -> { id, version_id, url } where `url` is a short-lived signed URL for a
//        .tar.gz containing `<Title>/SKILL.md` (rendered, with name/description
//        frontmatter) plus the page's Files-property attachments.
//
// `version_id` is an opaque content hash: equal ids mean the skill is unchanged,
// which is what lets a consumer skip re-downloading untouched skills. Building
// an archive is real server-side work (render the page, fetch every attachment,
// upload a tarball), so `retrieve` is the expensive call and `list` is cheap.
//
// Scope note: the API returns every live skill in the bot's workspace that the
// token can read. There is no per-row publish flag — what a consumer sees is
// governed by which pages the Notion connection has access to.
//
// These endpoints lived at /v1/skills/plugins and /v1/skills/directories/:id
// before 2026-07; the old paths now 400 with `invalid_request_url`. The response
// envelope moved to Notion's standard paginated list at the same time (`results`
// + `has_more`/`next_cursor`), and a plugin's skills come back under `skills`
// rather than `skill_directories`.

import { downloadArchive, extractSkillArchive, type SkillFiles } from "./archive.ts";
import {
  collectPaginated,
  NotionApiError,
  NotionErrorCode,
  type NotionHttp,
  type PaginatedArgs,
  type PaginatedList,
} from "./http.ts";

/** One skill in a plugin, as reported by the list endpoint. */
export interface Skill {
  id: string;
  /** Page title, kebab-cased by Notion. */
  name: string;
  description: string;
  updated_at: string;
  /** Opaque hash; compare for equality to detect changes. */
  version_id: string;
}

/** A skills grouping in the workspace — a team's plugin, or Notion's built-in one. */
export interface SkillsPlugin {
  id: string;
  name: string;
  description: string;
  version_id: string;
  skills: Skill[];
}

/** A skill's downloadable directory archive. */
export interface SkillArchive {
  id: string;
  version_id: string;
  /** Short-lived signed URL for the directory's .tar.gz. */
  url: string;
}

export type ListPluginsArgs = PaginatedArgs;
export type ListPluginsResponse = PaginatedList<SkillsPlugin>;

export const PLUGINS_PATH = "/v1/ai/plugins";
export const SKILLS_PATH = "/v1/ai/skills";

/**
 * The `plugins` and `skills` namespaces, built over the shared transport.
 *
 * `skills.files()` is the one method that isn't a bare endpoint: it resolves the
 * archive, downloads it, and extracts it, because no consumer wants a signed URL
 * for its own sake.
 */
export function skillsResources(http: NotionHttp) {
  const plugins = {
    /** One page of the workspace's skills plugins. */
    list: (args: ListPluginsArgs = {}): Promise<ListPluginsResponse> =>
      request<ListPluginsResponse>(http, {
        path: PLUGINS_PATH,
        query: { start_cursor: args.start_cursor, page_size: args.page_size },
      }),

    /**
     * Every skills plugin visible to the token, across all pages.
     *
     * The endpoint currently answers with the whole list in one page (it ignores
     * `page_size`), but it does emit the standard `has_more`/`next_cursor`
     * envelope, so follow the cursor rather than assuming one page forever.
     */
    listAll: (args: ListPluginsArgs = {}): Promise<SkillsPlugin[]> =>
      collectPaginated<ListPluginsArgs, SkillsPlugin>((a) => plugins.list(a), args),
  };

  const skills = {
    /**
     * Resolve a skill's downloadable archive. Expensive server-side (render +
     * attachment fetch + upload), so only call it for skills whose `version_id`
     * actually changed.
     */
    retrieve: ({ skill_id }: { skill_id: string }): Promise<SkillArchive> =>
      request<SkillArchive>(http, {
        path: `${SKILLS_PATH}/${encodeURIComponent(skill_id)}`,
      }),

    /**
     * Resolve, download, and extract a skill's directory into files.
     *
     * `skill_slug` is optional and only used to recognise an attachment zip
     * that wraps its contents in a folder named after the skill (see
     * `stripSingleTopLevelDir`).
     */
    files: async ({
      skill_id,
      skill_slug,
    }: {
      skill_id: string;
      skill_slug?: string;
    }): Promise<SkillFiles> => {
      const { url } = await skills.retrieve({ skill_id });
      return extractSkillArchive(
        await downloadArchive(url, (u) => http.fetchUrl(u)),
        skill_slug,
      );
    },
  };

  return { plugins, skills };
}

// The failure worth spelling out: these endpoints sit behind the
// `public_api_skills_plugins` gate, and a workspace without it gets the same
// 403 restricted_resource as a token missing read access. Say both, because the
// fix is completely different.
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
          `    - the access token lacking read content access to the skills.`,
      );
    }
    if (err.status === 401) {
      throw err.withHint("  The Notion access token is missing or invalid.");
    }
    if (err.status === 400 && err.code === NotionErrorCode.InvalidRequestURL) {
      throw err.withHint(
        `  The Skills API route was rejected outright. These endpoints moved once ` +
          `(from /v1/skills/*), so suspect a route rename before a permissions problem.`,
      );
    }
    throw err;
  }
}
