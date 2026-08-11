// Auth header, API version, retries, and one error type.
//
// Back-off is deterministic (no jitter): this is a single scheduled job with no
// herd to spread out, and it makes the retry math directly testable.

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
  /** An access token: an integration token, or an OAuth `access_token`. */
  auth: string;
  /** Convenience host selector; `baseUrl` wins if both are given. */
  env?: NotionEnv;
  baseUrl?: string;
  notionVersion?: string;
  fetch?: FetchLike;
  retry?: RetryOptions | false;
  logger?: NotionLogger;
}

/**
 * Branch on `code` (Notion's own), not status: 403 covers both a missing
 * feature gate and a token without access.
 */
export class NotionApiError extends Error {
  readonly name = "NotionApiError";
  readonly status: number;
  readonly code: string;
  readonly body: string;
  readonly requestId: string | undefined;
  readonly path: string;
  /** Extra, endpoint-specific guidance appended to the message. */
  readonly hint: string | undefined;

  constructor(args: {
    status: number;
    code: string;
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
  code: string;
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
 * Delay before retrying a `fetch` that threw instead of answering — a dropped
 * socket, a reset connection, a DNS blip. Null if not retryable.
 *
 * These carry no status and no `Retry-After`, so the decision rests entirely on
 * the method: a GET that died in transit can be reissued, a POST cannot be
 * (the request may well have been applied before the connection dropped).
 *
 * A cold sync makes hundreds of requests over a few minutes, so a transport
 * failure somewhere in the run is ordinary rather than exceptional — before
 * this, one dropped socket at request 52 of 424 failed the whole sync.
 */
export function transportRetryDelayMs(args: {
  method: string;
  attempt: number; // 0-based: the attempt that just failed
  retry?: RetryOptions;
}): number | null {
  if (args.method !== "GET" && args.method !== "DELETE") return null;
  const initial = args.retry?.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
  const max = args.retry?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  return Math.min(initial * 2 ** args.attempt, max);
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

export interface RequestArgs {
  path: string;
  method?: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
}

export class NotionHttp {
  readonly baseUrl: string;
  readonly notionVersion: string;
  private readonly authorization: string;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryOptions | false;
  private readonly logger: NotionLogger | undefined;

  constructor(options: NotionClientOptions) {
    const token = options.auth.trim();
    if (!token) throw new Error("Notion credential: token is empty.");
    this.authorization = `Bearer ${token}`;
    this.baseUrl = apiBaseUrl(options.env ?? DEFAULT_ENV, { baseUrl: options.baseUrl });
    this.notionVersion = options.notionVersion ?? DEFAULT_NOTION_VERSION;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.retry = options.retry ?? {};
    this.logger = options.logger;
  }

  /**
   * GET a URL (no Notion auth headers) and read it to bytes, with retries.
   *
   * Reading the body belongs *inside* the retry: a connection that drops
   * mid-transfer throws from `arrayBuffer()`, long after the response headers
   * arrived, and retrying only the initial `fetch` would miss exactly that.
   */
  async fetchBytes(url: string, label = "download"): Promise<Uint8Array> {
    return await this.send({
      url,
      method: "GET",
      label,
      consume: async (res) => new Uint8Array(await res.arrayBuffer()),
      fail: async (res) =>
        new Error(`Failed to download ${label} (${res.status} ${res.statusText}): ${url}`),
    });
  }

  async request<T>(args: RequestArgs): Promise<T> {
    const method = args.method ?? "GET";
    const path = args.path + buildQuery(args.query);

    return await this.send<T>({
      url: `${this.baseUrl}${path}`,
      method,
      label: path,
      init: {
        method,
        headers: {
          Authorization: this.authorization,
          "Notion-Version": this.notionVersion,
          "User-Agent": "notion-skills-github-sync",
          ...(args.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
      },
      consume: async (res) => (await res.json()) as T,
      fail: (res) => this.toError(res, path),
    });
  }

  /**
   * One request, retried. `consume` runs inside the loop so a body that dies
   * mid-read is retried like any other transport failure; `fail` builds the
   * error for a response that isn't worth retrying.
   */
  private async send<T>(args: {
    url: string;
    method: string;
    label: string;
    init?: Parameters<FetchLike>[1];
    consume: (res: Response) => Promise<T>;
    fail: (res: Response) => Promise<Error>;
  }): Promise<T> {
    const maxRetries = this.retry === false ? 0 : (this.retry.maxRetries ?? DEFAULT_MAX_RETRIES);

    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let value: T | undefined;
      let consumed = false;
      let thrown: unknown;
      try {
        res = await this.fetchImpl(args.url, args.init);
        if (res.ok) {
          value = await args.consume(res);
          consumed = true;
        }
      } catch (err) {
        thrown = err;
      }
      if (consumed) return value as T;

      const transport = res === undefined || thrown !== undefined;
      const wait =
        this.retry === false
          ? null
          : transport
            ? transportRetryDelayMs({ method: args.method, attempt, retry: this.retry })
            : retryDelayMs({
                status: res!.status,
                headers: res!.headers,
                method: args.method,
                attempt,
                retry: this.retry,
              });

      if (wait === null || attempt >= maxRetries) {
        if (thrown !== undefined) throw thrown;
        throw await args.fail(res!);
      }

      this.logger?.(
        "warn",
        (transport
          ? `Notion request to ${args.label} failed (${errorText(thrown)})`
          : `Notion ${res!.status} on ${args.label}`) +
          `; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${maxRetries}).`,
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
