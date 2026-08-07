// The single entry point for reading skills out of Notion — the reusable half
// of this repo, importable on its own. One import gets the whole capability.
//
//   const notion = new NotionClient({ auth: TOKEN, env: "prod" });
//   for (const plugin of await notion.plugins.listAll())
//     for (const skill of plugin.skills)
//       await notion.skills.files({ skill_id: skill.id }); // -> files["SKILL.md"], …
//
// The shape follows `@notionhq/client` (verified against 5.23.3) so these
// capabilities could be lifted into the SDK with no redesign.

import { NotionHttp, type NotionClientOptions } from "./http.ts";
import { skillsResources } from "./skills.ts";

export class NotionClient {
  /** Escape hatch for endpoints this client doesn't wrap yet. */
  readonly http: NotionHttp;
  readonly plugins: ReturnType<typeof skillsResources>["plugins"];
  readonly skills: ReturnType<typeof skillsResources>["skills"];

  constructor(options: NotionClientOptions) {
    this.http = new NotionHttp(options);
    const resources = skillsResources(this.http);
    this.plugins = resources.plugins;
    this.skills = resources.skills;
  }
}

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

export { staticToken, toCredential, type Credential } from "./auth.ts";

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
