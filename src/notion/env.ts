// Host resolution for Notion environments: the Skills API host, the app host
// used for page links, and the MCP host bundled into the injected updater.
// Keeping them here is what makes `notionEnv: "dev"` flip all three at once.

/** Named envs resolve specially; anything else is `api-<env>.notion.com`. */
export type NotionEnv = "prod" | "dev" | "local" | (string & {});

export const DEFAULT_ENV: NotionEnv = "prod";

/** A local notion-next dev server. Shape of the env axis; never exercised. */
const LOCAL_HOST = "http://localhost:3000";

export interface HostOverrides {
  /** Wins over the env-derived API host (e.g. NOTION_BASE_URL). */
  baseUrl?: string;
}

export function apiBaseUrl(env: NotionEnv, overrides: HostOverrides = {}): string {
  if (overrides.baseUrl) return stripTrailingSlash(overrides.baseUrl);
  if (env === "prod") return "https://api.notion.com";
  if (env === "local") return LOCAL_HOST;
  return `https://api-${env}.notion.com`;
}

export function appBaseUrl(env: NotionEnv): string {
  if (env === "prod") return "https://www.notion.so";
  if (env === "local") return LOCAL_HOST;
  return `https://app.${env}.notion.com`;
}

export function pageUrl(env: NotionEnv, pageId: string): string {
  return `${appBaseUrl(env)}/p/${pageId.replace(/-/g, "")}`;
}

export function mcpUrl(env: NotionEnv): string {
  if (env === "local") return `${LOCAL_HOST}/mcp`;
  const host = env === "prod" ? "mcp.notion.com" : `mcp-${env}.notion.com`;
  return `https://${host}/mcp`;
}

/** The connection's display name in an MCP client's list. */
export function mcpServerName(env: NotionEnv): string {
  return env === "prod" ? "notion" : `notion-${env}`;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
