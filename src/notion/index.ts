// The single entry point for reading plugins out of Notion — the reusable half
// of this repo, importable on its own. One import gets the whole capability.
//
//   const notion = new NotionClient({ auth: TOKEN, env: "prod" });
//   for (const plugin of await notion.plugins.listAll()) {
//     const { files } = await notion.plugins.files({ plugin_id: plugin.id });
//     // files["plugin.json"], files["skills/summarize/SKILL.md"], …
//   }

import { NotionHttp, type NotionClientOptions } from "./http.ts";
import { PluginResource } from "./plugins.ts";

export class NotionClient {
  /** Escape hatch for endpoints this client doesn't wrap yet. */
  readonly http: NotionHttp;
  readonly plugins: PluginResource;

  constructor(options: NotionClientOptions) {
    this.http = new NotionHttp(options);
    this.plugins = new PluginResource(this.http);
  }
}

// The rest of what a consumer of this directory needs, so one import really is
// the whole capability: the error type (branch on `code` — e.g. the
// `directory_not_found` retain-and-retry case), the API's own shapes, and the
// env axis the options take.
export type { NotionClientOptions } from "./http.ts";
export { NotionApiError } from "./http.ts";
export type { NotionEnv } from "./env.ts";
export type { Plugin, PluginArchiveRef, ListPluginsArgs } from "./plugins.ts";
export type { PluginFiles } from "./archive.ts";
