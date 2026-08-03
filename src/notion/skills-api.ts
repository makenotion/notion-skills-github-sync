// Client for Notion's Skills Public API.
//
// This replaces everything the sync used to do by hand against the generic page
// API: querying a data source, resolving canonical-vs-legacy property ids,
// fetching page bodies as Markdown, deriving a description, and rendering
// SKILL.md. Notion now does all of that server-side:
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
// `version_id` is an opaque content hash: equal ids mean the skill is
// unchanged, which is what lets the sync skip re-downloading untouched skills.
//
// Scope note: the API returns every live skill in the bot's workspace that the
// token can read. There is no per-row publish flag — what gets synced is
// governed by which pages the Notion connection has access to.
//
// These endpoints lived at /v1/skills/plugins and /v1/skills/directories/:id
// before 2026-07; the old paths now 400 with `invalid_request_url`. The
// response envelope moved to Notion's standard paginated list at the same time
// (`results` + `has_more`/`next_cursor`), and a plugin's skills come back under
// `skills` rather than `skill_directories`.

// The API version the skills endpoints were shipped against.
export const SKILLS_API_VERSION = "2025-09-03";

const MAX_RETRIES = 3;
// Fallback pause when a 429 arrives without a `Retry-After`. The documented
// budget is an average of 3 requests/second per connection, so a second is
// enough to clear a short burst.
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_WAIT_MS = 60_000;

/**
 * How long to wait before retrying, or null if this isn't a rate limit.
 *
 * 429 is the documented rate-limit status and carries `Retry-After` in
 * seconds; 529 means the service is overloaded and Notion asks that it be
 * handled the same way.
 */
export function rateLimitDelayMs(res: {
  status: number;
  headers: { get(name: string): string | null };
}): number | null {
  if (res.status !== 429 && res.status !== 529) return null;
  // `Number(null)` is 0, so an absent header has to be distinguished from a
  // header that genuinely says "retry immediately".
  const raw = res.headers.get("retry-after");
  const retryAfter = raw === null ? Number.NaN : Number(raw);
  const ms =
    Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter * 1000 + 250
      : DEFAULT_RATE_LIMIT_WAIT_MS;
  return Math.min(ms, MAX_WAIT_MS);
}

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
  skills: SkillDirectorySummary[];
}

export interface SkillDirectoryArchive {
  id: string;
  version_id: string;
  /** Short-lived signed URL for the directory's .tar.gz. */
  url: string;
}

interface PluginListResponse {
  results: SkillsPlugin[];
  has_more?: boolean;
  next_cursor?: string | null;
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
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": SKILLS_API_VERSION,
          "User-Agent": "notion-skills-github-sync",
        },
      });
      if (res.ok) return (await res.json()) as T;

      const wait = rateLimitDelayMs(res);
      if (wait === null || attempt >= MAX_RETRIES) {
        throw new Error(await describeFailure(res, path, this.env));
      }
      console.warn(
        `  ⏳ Notion rate limit on ${path}; waiting ${Math.round(wait / 1000)}s ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES}).`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /**
   * Every skills plugin visible to the token, across all pages.
   *
   * The endpoint currently answers with the whole list in one page (it ignores
   * `page_size`), but it does emit the standard `has_more`/`next_cursor`
   * envelope, so follow the cursor rather than assuming one page forever.
   */
  async listPlugins(): Promise<SkillsPlugin[]> {
    const plugins: SkillsPlugin[] = [];
    let cursor: string | undefined;
    do {
      const path = cursor
        ? `/v1/ai/plugins?start_cursor=${encodeURIComponent(cursor)}`
        : "/v1/ai/plugins";
      const res = await this.get<PluginListResponse>(path);
      plugins.push(...(res.results ?? []));
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return plugins;
  }

  /** Resolve a skill's downloadable archive. Building it is server-side
   *  work (render + attachment fetch + upload), so only call it for skills
   *  whose `version_id` actually changed. */
  async getDirectoryArchive(skillId: string): Promise<SkillDirectoryArchive> {
    return await this.get<SkillDirectoryArchive>(
      `/v1/ai/skills/${encodeURIComponent(skillId)}`,
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
