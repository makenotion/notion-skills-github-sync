// Host resolution for Notion environments: the Skills API host, the app host
// used for page links, and the MCP host bundled into the injected updater.
// Keeping them here is what makes `notionEnv: "dev"` flip all three at once.

/** `prod` resolves specially; anything else is an internal env like `api-<env>`. */
export type NotionEnv = "prod" | "dev" | (string & {});

export const DEFAULT_ENV: NotionEnv = "prod";

export function apiBaseUrl(env: NotionEnv, overrides: { baseUrl?: string } = {}): string {
  // NOTION_BASE_URL flows through here and wins over the env-derived host.
  if (overrides.baseUrl) return overrides.baseUrl.replace(/\/+$/, "");
  if (env === "prod") return "https://api.notion.com";
  return `https://api-${env}.notion.com`;
}

export function appBaseUrl(env: NotionEnv): string {
  if (env === "prod") return "https://www.notion.so";
  return `https://app.${env}.notion.com`;
}

export function pageUrl(env: NotionEnv, pageId: string): string {
  return `${appBaseUrl(env)}/p/${pageId.replace(/-/g, "")}`;
}

export function mcpUrl(env: NotionEnv): string {
  const host = env === "prod" ? "mcp.notion.com" : `mcp-${env}.notion.com`;
  return `https://${host}/mcp`;
}

/** The connection's display name in an MCP client's list. */
export function mcpServerName(env: NotionEnv): string {
  return env === "prod" ? "notion" : `notion-${env}`;
}
