// The Skills Public API. `list` is cheap; `retrieve` is expensive server-side
// (render + attachment fetch + upload), so use `version_id` to skip it.
//
// No per-row publish flag: the API returns every live skill the token can read,
// so access to the connection is what governs what a consumer sees.
//
// These endpoints moved from /v1/skills/* in 2026-07 — the old paths now 400
// with `invalid_request_url`, which looks nothing like a permissions failure.

import { downloadArchive, extractSkillArchive, type SkillFiles } from "./archive.ts";
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

export function skillsResources(http: NotionHttp) {
  const plugins = {
    list: (args: ListPluginsArgs = {}): Promise<ListPluginsResponse> =>
      request<ListPluginsResponse>(http, {
        path: PLUGINS_PATH,
        query: { start_cursor: args.start_cursor, page_size: args.page_size },
      }),

    /** The server ignores `page_size` but does emit a cursor — so follow it. */
    listAll: (args: ListPluginsArgs = {}): Promise<SkillsPlugin[]> =>
      collectPaginated<ListPluginsArgs, SkillsPlugin>((a) => plugins.list(a), args),
  };

  const skills = {
    retrieve: ({ skill_id }: { skill_id: string }): Promise<SkillArchive> =>
      request<SkillArchive>(http, {
        path: `${SKILLS_PATH}/${encodeURIComponent(skill_id)}`,
      }),

    /** `skill_slug` only helps recognise a zip wrapped in a folder named after
     *  the skill (see `stripSingleTopLevelDir`). */
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

// A workspace without the `public_api_skills_plugins` gate gets the same 403 as
// a token missing read access, so name both causes — the fixes differ entirely.
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
