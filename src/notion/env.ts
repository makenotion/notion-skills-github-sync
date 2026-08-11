// Host resolution for Notion environments: the Skills API host and the app host
// used for page links. Keeping them here is what makes `notionEnv: "dev"` flip
// both at once.

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
