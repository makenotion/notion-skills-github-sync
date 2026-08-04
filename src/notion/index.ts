// The single entry point for talking to Notion's Skills API.
//
// This directory is the reusable half of this repo: everything here is about
// *reading skills out of Notion* and nothing about publishing them anywhere. A
// consumer should need exactly one import:
//
//   import { NotionClient } from "./notion/index.ts";
//
//   const notion = new NotionClient({ auth: process.env.NOTION_API_TOKEN!, env: "prod" });
//   for (const plugin of await notion.plugins.listAll()) {
//     for (const skill of plugin.skills) {
//       const { files } = await notion.skills.files({ skill_id: skill.id });
//       // files["SKILL.md"], files["scripts/run.py"], …
//     }
//   }
//
// The shape follows `@notionhq/client` (verified against 5.23.3) so that these
// capabilities could be lifted into the SDK with no redesign: a constructor
// taking `{ auth, baseUrl, notionVersion, fetch, retry }`, namespaced resource
// methods taking argument objects, an error type carrying Notion's own `code`,
// and a `collectPaginated` mirroring `collectPaginatedAPI`.

import { NotionHttp, type NotionClientOptions } from "./http.ts";
import { skillsResources } from "./skills.ts";

export class NotionClient {
  /** Escape hatch for endpoints this client doesn't wrap yet. */
  readonly http: NotionHttp;
  /** `/v1/ai/plugins` — the workspace's skills groupings. */
  readonly plugins: ReturnType<typeof skillsResources>["plugins"];
  /** `/v1/ai/skills/:id` — a skill's archive, and its extracted files. */
  readonly skills: ReturnType<typeof skillsResources>["skills"];

  constructor(options: NotionClientOptions) {
    this.http = new NotionHttp(options);
    const resources = skillsResources(this.http);
    this.plugins = resources.plugins;
    this.skills = resources.skills;
  }
}

// --- Environments -----------------------------------------------------------
export {
  apiBaseUrl,
  appBaseUrl,
  DEFAULT_ENV,
  mcpServerName,
  mcpUrl,
  pageUrl,
  type HostOverrides,
  type NotionEnv,
} from "./env.ts";

// --- Auth -------------------------------------------------------------------
export { staticToken, toCredential, type Credential } from "./auth.ts";

// --- Transport, errors, pagination -----------------------------------------
export {
  collectPaginated,
  DEFAULT_INITIAL_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_NOTION_VERSION,
  NotionApiError,
  NotionErrorCode,
  NotionHttp,
  retryDelayMs,
  type FetchLike,
  type LogLevel,
  type NotionClientOptions,
  type NotionLogger,
  type PaginatedArgs,
  type PaginatedList,
  type RequestArgs,
  type RetryOptions,
} from "./http.ts";

// --- Skills resources -------------------------------------------------------
export {
  PLUGINS_PATH,
  SKILLS_PATH,
  skillsResources,
  type ListPluginsArgs,
  type ListPluginsResponse,
  type Skill,
  type SkillArchive,
  type SkillsPlugin,
} from "./skills.ts";

// --- Archives ---------------------------------------------------------------
export {
  downloadArchive,
  extractSkillArchive,
  isSafeEntryPath,
  SKILL_MD,
  unzipSkillArchive,
  zipSkillFiles,
  type SkillFiles,
} from "./archive.ts";
export { untar, type TarEntry } from "./untar.ts";
