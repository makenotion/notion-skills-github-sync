// Host resolution for Notion environments.
//
// Everything that needs to know *where* Notion lives goes through here: the
// Skills API host, the app host used for human-readable page links, and the
// remote MCP host bundled into the injected updater plugin. Keeping them in one
// module is what makes `notionEnv: "dev"` flip all three at once instead of
// three places each growing their own `env === "prod" ? … : …`.
//
// `local` points at a notion-next dev server. It's here because the shape of
// the environment axis is prod | dev | local, not because it's verified — a
// local Skills API has never been exercised by this tool.

/**
 * A Notion environment. The named ones are the ones we resolve specially;
 * anything else is treated as an internal env named after itself (`stg` ->
 * `api-stg.notion.com`).
 */
export type NotionEnv = "prod" | "dev" | "local" | (string & {});

export const DEFAULT_ENV: NotionEnv = "prod";

/** Where a local notion-next dev server serves the API from. */
const LOCAL_HOST = "http://localhost:3000";

export interface HostOverrides {
  /** Wins over the env-derived API host (e.g. NOTION_BASE_URL). */
  baseUrl?: string;
}

/**
 * Base URL for the public API.
 *   prod  -> https://api.notion.com
 *   dev   -> https://api-dev.notion.com
 *   local -> http://localhost:3000
 */
export function apiBaseUrl(env: NotionEnv, overrides: HostOverrides = {}): string {
  if (overrides.baseUrl) return stripTrailingSlash(overrides.baseUrl);
  if (env === "prod") return "https://api.notion.com";
  if (env === "local") return LOCAL_HOST;
  return `https://api-${env}.notion.com`;
}

/**
 * Base URL for the app, used for the human-openable page links we write into
 * skill markers.
 *   prod  -> https://www.notion.so
 *   dev   -> https://app.dev.notion.com
 *   local -> http://localhost:3000
 */
export function appBaseUrl(env: NotionEnv): string {
  if (env === "prod") return "https://www.notion.so";
  if (env === "local") return LOCAL_HOST;
  return `https://app.${env}.notion.com`;
}

/** Link to a page by id, as written into a skill's sync marker. */
export function pageUrl(env: NotionEnv, pageId: string): string {
  return `${appBaseUrl(env)}/p/${pageId.replace(/-/g, "")}`;
}

/**
 * Remote MCP endpoint, bundled into the injected updater plugin.
 *   prod -> https://mcp.notion.com/mcp
 *   dev  -> https://mcp-dev.notion.com/mcp
 */
export function mcpUrl(env: NotionEnv): string {
  if (env === "local") return `${LOCAL_HOST}/mcp`;
  const host = env === "prod" ? "mcp.notion.com" : `mcp-${env}.notion.com`;
  return `https://${host}/mcp`;
}

/**
 * The `mcpServers` key — i.e. the connection's display name in an MCP client's
 * list. Env-suffixed off prod so a dev connector is distinguishable from the
 * real one.
 */
export function mcpServerName(env: NotionEnv): string {
  return env === "prod" ? "notion" : `notion-${env}`;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
