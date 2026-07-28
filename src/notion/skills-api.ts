// Client for Notion's Skills Public API.
//
// This replaces everything the sync used to do by hand against the generic page
// API: querying a data source, resolving canonical-vs-legacy property ids,
// fetching page bodies as Markdown, deriving a description, and rendering
// SKILL.md. Notion now does all of that server-side:
//
//   GET /v1/skills/plugins
//     -> the workspace's skills plugin and every skill directory in it
//        ({ id, name, description, updated_at, version_id }). `name` is the
//        page title kebab-cased; `description` already has Notion's own
//        first-line fallback applied.
//
//   GET /v1/skills/directories/:id
//     -> { id, version_id, url } where `url` is a short-lived signed URL for a
//        .tar.gz containing `<Title>/SKILL.md` (rendered, with name/description
//        frontmatter) plus the page's Files-property attachments.
//
// `version_id` is an opaque content hash: equal ids mean the directory is
// unchanged, which is what lets the sync skip re-downloading untouched skills.
//
// Scope note: the API returns every live skill in the bot's workspace that the
// token can read. There is no per-row publish flag — what gets synced is
// governed by which pages the Notion connection has access to.

// The API version the skills endpoints were shipped against.
export const SKILLS_API_VERSION = "2025-09-03";

// prod -> https://api.notion.com, dev -> https://api-dev.notion.com
export function notionApiBaseUrl(env: string): string {
  return env === "prod" ? "https://api.notion.com" : `https://api-${env}.notion.com`;
}

export interface SkillDirectorySummary {
  id: string;
  /** Page title, kebab-cased by Notion. Used as the skill slug. */
  name: string;
  description: string;
  updated_at: string;
  /** Opaque hash; compare for equality to detect changes. */
  version_id: string;
}

export interface SkillsPlugin {
  id: string;
  name: string;
  description: string;
  version_id: string;
  skill_directories: SkillDirectorySummary[];
}

export interface SkillDirectoryArchive {
  id: string;
  version_id: string;
  /** Short-lived signed URL for the directory's .tar.gz. */
  url: string;
}

interface PluginListResponse {
  results: SkillsPlugin[];
}

export class NotionSkillsApi {
  private readonly baseUrl: string;

  constructor(
    private readonly env: string,
    private readonly token: string,
  ) {
    this.baseUrl = notionApiBaseUrl(env);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": SKILLS_API_VERSION,
        "User-Agent": "notion-skills-github-sync",
      },
    });
    if (!res.ok) {
      throw new Error(await describeFailure(res, path, this.env));
    }
    return (await res.json()) as T;
  }

  /** Every skills plugin visible to the token (today: exactly one). */
  async listPlugins(): Promise<SkillsPlugin[]> {
    const res = await this.get<PluginListResponse>("/v1/skills/plugins");
    return res.results ?? [];
  }

  /** Resolve a directory's downloadable archive. Building it is server-side
   *  work (render + attachment fetch + upload), so only call it for directories
   *  whose `version_id` actually changed. */
  async getDirectoryArchive(directoryId: string): Promise<SkillDirectoryArchive> {
    return await this.get<SkillDirectoryArchive>(
      `/v1/skills/directories/${encodeURIComponent(directoryId)}`,
    );
  }
}

// The one failure mode worth spelling out: the endpoints sit behind the
// `public_api_skills_plugins` gate, and a workspace without it gets the same
// 403 restricted_resource as a token missing read access. Say both.
async function describeFailure(res: Response, path: string, env: string): Promise<string> {
  const body = await res.text().catch(() => "");
  let code = "";
  try {
    code = (JSON.parse(body) as { code?: string }).code ?? "";
  } catch {
    // non-JSON error body; fall through with the raw text
  }

  if (res.status === 403 && code === "restricted_resource") {
    return (
      `Notion skills API returned 403 restricted_resource for ${path}.\n` +
      `  This is either:\n` +
      `    - the 'public_api_skills_plugins' feature gate being off for the ${env} ` +
      `workspace (ask the Public API team to enable it), or\n` +
      `    - NOTION_API_TOKEN lacking read content access to the skills.`
    );
  }
  if (res.status === 401) {
    return `Notion skills API returned 401 for ${path}: NOTION_API_TOKEN is missing or invalid.`;
  }
  return `Notion skills API ${path} failed (${res.status} ${res.statusText}): ${body.trim()}`;
}
