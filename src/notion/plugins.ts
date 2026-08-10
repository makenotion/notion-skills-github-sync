// The Plugins Public API. `list` is cheap; `retrieve` is expensive server-side
// (render + attachment fetch + upload of a whole plugin), so use the plugin's
// `version_id` to skip it.
//
// No per-row publish flag: the API returns every live plugin the token can
// read, so access to the connection is what governs what a consumer sees.
//
// The plugin is the only unit here. `list` reports a plugin's identity and
// version; `/v1/ai/plugins/:id` yields a signed `.tar.gz` for the whole plugin,
// laid out to the Agent Plugins 1.0 standard. The API exposes no skill-level
// resource at all — a plugin's skills are whatever its archive contains — so
// there is nothing to reconcile between a listing and an archive.

import { downloadArchive, extractPluginArchive, type PluginFiles } from "./archive.ts";
import {
  collectPaginated,
  NotionApiError,
  NotionErrorCode,
  type NotionHttp,
  type PaginatedArgs,
  type PaginatedList,
} from "./http.ts";

/** Exactly what `/v1/ai/plugins` reports for one plugin. */
export interface Plugin {
  id: string;
  /** Display name; slugified into a directory name by the sync. */
  name: string;
  description: string;
  /** Opaque hash covering the whole plugin; compare for equality. */
  version_id: string;
}

/** What `/v1/ai/plugins/:id` returns: a signed URL to the plugin's archive. */
export interface PluginArchiveRef {
  id: string;
  version_id: string;
  /** Short-lived signed URL for the whole plugin's .tar.gz. */
  url: string;
}

export type ListPluginsArgs = PaginatedArgs;
export type ListPluginsResponse = PaginatedList<Plugin>;

export const PLUGINS_PATH = "/v1/ai/plugins";

export function pluginResources(http: NotionHttp) {
  const plugins = {
    list: (args: ListPluginsArgs = {}): Promise<ListPluginsResponse> =>
      request<ListPluginsResponse>(http, {
        path: PLUGINS_PATH,
        query: { start_cursor: args.start_cursor, page_size: args.page_size },
      }),

    /** The server ignores `page_size` but does emit a cursor — so follow it. */
    listAll: (args: ListPluginsArgs = {}): Promise<Plugin[]> =>
      collectPaginated<ListPluginsArgs, Plugin>((a) => plugins.list(a), args),

    retrieve: ({ plugin_id }: { plugin_id: string }): Promise<PluginArchiveRef> =>
      request<PluginArchiveRef>(http, {
        path: `${PLUGINS_PATH}/${encodeURIComponent(plugin_id)}`,
      }),

    /** Download a plugin's archive and extract the files its directory needs. */
    files: async ({ plugin_id }: { plugin_id: string }): Promise<PluginFiles> => {
      const { url } = await plugins.retrieve({ plugin_id });
      return extractPluginArchive(await downloadArchive(url, (u) => http.fetchUrl(u)));
    },
  };

  return { plugins };
}

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
