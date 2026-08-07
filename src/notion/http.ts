// Auth header, API version, retries, and one error type. Shaped after
// `@notionhq/client`'s `Client` (verified against 5.23.3) on the assumption
// these capabilities may eventually live there.
//
// One deliberate divergence: back-off is deterministic (no jitter). The SDK
// jitters to spread a fleet of clients; this is a single scheduled job with no
// herd to avoid, and it makes the retry math directly testable.

import { toCredential, type Credential } from "./auth.ts";
import { apiBaseUrl, DEFAULT_ENV, type NotionEnv } from "./env.ts";

/** The API version the skills endpoints were shipped against. */
export const DEFAULT_NOTION_VERSION = "2025-09-03";

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** Narrow enough for a test to fake, wide enough for archive downloads. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

/** Error codes Notion returns in an error body. Mirrors the SDK's `APIErrorCode`. */
export const NotionErrorCode = {
  Unauthorized: "unauthorized",
  RestrictedResource: "restricted_resource",
  ObjectNotFound: "object_not_found",
  RateLimited: "rate_limited",
  InvalidJSON: "invalid_json",
  InvalidRequestURL: "invalid_request_url",
  InvalidRequest: "invalid_request",
  ValidationError: "validation_error",
  ConflictError: "conflict_error",
  InternalServerError: "internal_server_error",
  ServiceOverload: "service_overload",
  ServiceUnavailable: "service_unavailable",
  GatewayTimeout: "gateway_timeout",
} as const;

export type NotionErrorCode = (typeof NotionErrorCode)[keyof typeof NotionErrorCode] | (string & {});

export type LogLevel = "warn" | "info";
export type NotionLogger = (level: LogLevel, message: string) => void;

export interface RetryOptions {
  /** Attempts after the first. 0 disables retries. */
  maxRetries?: number;
  /** Base delay when the response carries no `Retry-After`. */
  initialRetryDelayMs?: number;
  /** Ceiling for any computed delay. */
  maxRetryDelayMs?: number;
}

export interface NotionClientOptions {
  /** An access token, or a `Credential` that resolves one per request. */
  auth: string | Credential;
  /** Convenience host selector; `baseUrl` wins if both are given. */
  env?: NotionEnv;
  baseUrl?: string;
  notionVersion?: string;
  fetch?: FetchLike;
  retry?: RetryOptions | false;
  logger?: NotionLogger;
  userAgent?: string;
}

/**
 * Branch on `code` (Notion's own), not status: 403 covers both a missing
 * feature gate and a token without access.
 */
export class NotionApiError extends Error {
  readonly name = "NotionApiError";
  readonly status: number;
  readonly code: NotionErrorCode;
  readonly body: string;
  readonly requestId: string | undefined;
  readonly path: string;
  /** Extra, endpoint-specific guidance appended to the message. */
  readonly hint: string | undefined;

  constructor(args: {
    status: number;
    code: NotionErrorCode;
    body: string;
    path: string;
    requestId?: string;
    hint?: string;
  }) {
    super(formatError(args));
    this.status = args.status;
    this.code = args.code;
    this.body = args.body;
    this.path = args.path;
    this.requestId = args.requestId;
    this.hint = args.hint;
  }

  /** The same failure, re-described with endpoint-specific guidance. */
  withHint(hint: string): NotionApiError {
    return new NotionApiError({
      status: this.status,
      code: this.code,
      body: this.body,
      path: this.path,
      requestId: this.requestId,
      hint,
    });
  }

  static is(err: unknown): err is NotionApiError {
    return err instanceof NotionApiError;
  }
}

function formatError(args: {
  status: number;
  code: NotionErrorCode;
  body: string;
  path: string;
  requestId?: string;
  hint?: string;
}): string {
  const head =
    `Notion API ${args.path} failed (${args.status}` +
    (args.code ? ` ${args.code}` : "") +
    `)`;
  const parts = [args.hint ? `${head}.\n${args.hint}` : `${head}: ${args.body.trim()}`];
  if (args.requestId) parts.push(`  request_id: ${args.requestId}`);
  return parts.join("\n");
}

/**
 * Delay before retrying, or null if not retryable. 429 (rate limit, carries
 * `Retry-After`), 529 (overloaded, treated the same), and 5xx are worth
 * retrying; 401/403/404/validation will fail identically next time.
 */
export function retryDelayMs(args: {
  status: number;
  headers: { get(name: string): string | null };
  method: string;
  attempt: number; // 0-based: the attempt that just failed
  retry?: RetryOptions;
}): number | null {
  const { status, headers, method, attempt } = args;
  const initial = args.retry?.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
  const max = args.retry?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

  const rateLimited = status === 429 || status === 529;
  const idempotent = method === "GET" || method === "DELETE";
  const serverError = status >= 500 && status < 600;
  if (!rateLimited && !(serverError && idempotent)) return null;

  // `Number(null)` is 0 — distinguish absent from "retry immediately".
  const raw = headers.get("retry-after");
  const seconds = raw === null ? Number.NaN : Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    // Retry-After is whole seconds, so pad: the window may not have elapsed.
    return Math.min(seconds * 1000 + 250, max);
  }

  return Math.min(initial * 2 ** attempt, max);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A standard Notion paginated list. */
export interface PaginatedList<T> {
  object?: "list";
  results: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface PaginatedArgs {
  start_cursor?: string | null;
  page_size?: number;
}

/** Mirrors the SDK's `collectPaginatedAPI`, incl. taking a bound list method. */
export async function collectPaginated<Args extends PaginatedArgs, Item>(
  list: (args: Args) => Promise<PaginatedList<Item>>,
  firstPageArgs: Args = {} as Args,
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await list(cursor ? { ...firstPageArgs, start_cursor: cursor } : firstPageArgs);
    items.push(...(page.results ?? []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return items;
}

export interface RequestArgs {
  path: string;
  method?: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
}

export class NotionHttp {
  readonly baseUrl: string;
  readonly notionVersion: string;
  private readonly credential: Credential;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryOptions | false;
  private readonly logger: NotionLogger | undefined;
  private readonly userAgent: string;

  constructor(options: NotionClientOptions) {
    this.credential = toCredential(options.auth);
    this.baseUrl = apiBaseUrl(options.env ?? DEFAULT_ENV, { baseUrl: options.baseUrl });
    this.notionVersion = options.notionVersion ?? DEFAULT_NOTION_VERSION;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.retry = options.retry ?? {};
    this.logger = options.logger;
    this.userAgent = options.userAgent ?? "notion-skills-github-sync";
  }

  /** Fetch a URL with this client's `fetch`, without Notion auth headers. */
  async fetchUrl(url: string): Promise<Response> {
    return await this.fetchImpl(url);
  }

  async request<T>(args: RequestArgs): Promise<T> {
    const method = args.method ?? "GET";
    const path = args.path + buildQuery(args.query);
    const maxRetries = this.retry === false ? 0 : (this.retry.maxRetries ?? DEFAULT_MAX_RETRIES);

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.credential.getToken()}`,
          "Notion-Version": this.notionVersion,
          "User-Agent": this.userAgent,
          ...(args.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
      });
      if (res.ok) return (await res.json()) as T;

      const wait =
        this.retry === false
          ? null
          : retryDelayMs({
              status: res.status,
              headers: res.headers,
              method,
              attempt,
              retry: this.retry,
            });
      if (wait === null || attempt >= maxRetries) throw await this.toError(res, path);

      this.logger?.(
        "warn",
        `Notion ${res.status} on ${path}; retrying in ${Math.round(wait / 1000)}s ` +
          `(attempt ${attempt + 1}/${maxRetries}).`,
      );
      await sleep(wait);
    }
  }

  private async toError(res: Response, path: string): Promise<NotionApiError> {
    const body = await res.text().catch(() => "");
    let code = "";
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(body) as { code?: string; request_id?: string };
      code = parsed.code ?? "";
      requestId = parsed.request_id;
    } catch {
      // Non-JSON body (a proxy or HTML error page): keep the text.
    }
    return new NotionApiError({ status: res.status, code, body, path, requestId });
  }
}

function buildQuery(query: RequestArgs["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}
