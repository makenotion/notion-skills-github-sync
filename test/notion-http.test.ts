import { describe, expect, test } from "bun:test";
import {
  collectPaginated,
  NotionHttp,
  retryDelayMs,
  transportRetryDelayMs,
} from "../src/notion/http.ts";

const headers = (h: Record<string, string> = {}) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

const delay = (args: {
  status: number;
  h?: Record<string, string>;
  method?: string;
  attempt?: number;
  initial?: number;
  max?: number;
}) =>
  retryDelayMs({
    status: args.status,
    headers: headers(args.h),
    method: args.method ?? "GET",
    attempt: args.attempt ?? 0,
    retry: { initialRetryDelayMs: args.initial, maxRetryDelayMs: args.max },
  });

describe("retryDelayMs", () => {
  test("honours Retry-After, padded, because the header is whole seconds", () => {
    expect(delay({ status: 429, h: { "retry-after": "2" } })).toBe(2250);
    // "retry immediately" is a real answer, and has to be distinguishable from
    // an absent header (Number(null) is 0).
    expect(delay({ status: 429, h: { "retry-after": "0" } })).toBe(250);
  });

  test("529 service overload is treated like a rate limit — Notion asks for that", () => {
    expect(delay({ status: 529, h: { "retry-after": "1" } })).toBe(1250);
  });

  test("backs off exponentially when no Retry-After is given", () => {
    expect(delay({ status: 429, attempt: 0, initial: 1000 })).toBe(1000);
    expect(delay({ status: 429, attempt: 1, initial: 1000 })).toBe(2000);
    expect(delay({ status: 429, attempt: 3, initial: 1000 })).toBe(8000);
  });

  test("caps every computed delay", () => {
    expect(delay({ status: 429, h: { "retry-after": "600" }, max: 60_000 })).toBe(60_000);
    expect(delay({ status: 429, attempt: 20, initial: 1000, max: 60_000 })).toBe(60_000);
  });

  test("ignores a nonsense Retry-After and falls back to back-off", () => {
    expect(delay({ status: 429, h: { "retry-after": "soon" }, initial: 500 })).toBe(500);
    expect(delay({ status: 429, h: { "retry-after": "-5" }, initial: 500 })).toBe(500);
  });

  test("retries 5xx on reads only — a failed write may have landed", () => {
    expect(delay({ status: 500, method: "GET", initial: 1000 })).toBe(1000);
    expect(delay({ status: 503, method: "DELETE", initial: 1000 })).toBe(1000);
    expect(delay({ status: 500, method: "POST" })).toBeNull();
  });

  test("does not retry what will fail identically next time", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(delay({ status })).toBeNull();
    }
  });
});

describe("transportRetryDelayMs", () => {
  test("backs off exponentially for reads, which can simply be reissued", () => {
    const args = { method: "GET", retry: { initialRetryDelayMs: 1000, maxRetryDelayMs: 60_000 } };
    expect(transportRetryDelayMs({ ...args, attempt: 0 })).toBe(1000);
    expect(transportRetryDelayMs({ ...args, attempt: 2 })).toBe(4000);
    expect(transportRetryDelayMs({ ...args, attempt: 20 })).toBe(60_000);
  });

  test("refuses writes — a dropped socket may still have applied the request", () => {
    expect(transportRetryDelayMs({ method: "POST", attempt: 0 })).toBeNull();
    expect(transportRetryDelayMs({ method: "PATCH", attempt: 0 })).toBeNull();
  });
});

// A cold sync is hundreds of requests, so a dropped connection somewhere in the
// run is routine. These cover the paths a status-only retry would have missed.
describe("NotionHttp transport failures", () => {
  const fast = { maxRetries: 3, initialRetryDelayMs: 1, maxRetryDelayMs: 5 };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  test("retries a fetch that throws instead of answering", async () => {
    let calls = 0;
    const http = new NotionHttp({
      auth: "ntn_x",
      baseUrl: "https://api.test",
      retry: fast,
      fetch: async () => {
        if (++calls < 3) throw new Error("The socket connection was closed unexpectedly");
        return ok({ id: "p1" });
      },
    });

    expect(await http.request<{ id: string }>({ path: "/v1/ai/plugins" })).toEqual({ id: "p1" });
    expect(calls).toBe(3);
  });

  test("retries a body that dies mid-read, not just a failed handshake", async () => {
    let calls = 0;
    const http = new NotionHttp({
      auth: "ntn_x",
      baseUrl: "https://api.test",
      retry: fast,
      fetch: async () => {
        if (++calls === 1) {
          // Headers arrived; the connection dies while streaming the body.
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            arrayBuffer: async () => {
              throw new Error("The socket connection was closed unexpectedly");
            },
          } as unknown as Response;
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    });

    expect(await http.fetchBytes("https://signed.example/archive.tar.gz")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(calls).toBe(2);
  });

  test("gives up after maxRetries and rethrows the transport error", async () => {
    let calls = 0;
    const http = new NotionHttp({
      auth: "ntn_x",
      baseUrl: "https://api.test",
      retry: { ...fast, maxRetries: 2 },
      fetch: async () => {
        calls++;
        throw new Error("ECONNRESET");
      },
    });

    await expect(http.fetchBytes("https://signed.example/a.tar.gz")).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(3); // the first attempt plus two retries
  });

  test("a non-ok download status still becomes a descriptive error", async () => {
    const http = new NotionHttp({
      auth: "ntn_x",
      baseUrl: "https://api.test",
      retry: fast,
      fetch: async () => new Response("nope", { status: 403, statusText: "Forbidden" }),
    });

    await expect(http.fetchBytes("https://signed.example/a.tar.gz", "plugin archive")).rejects.toThrow(
      /Failed to download plugin archive \(403 Forbidden\)/,
    );
  });
});

describe("collectPaginated", () => {
  test("follows the cursor to the end and concatenates results", async () => {
    const pages = [
      { results: ["a", "b"], has_more: true, next_cursor: "1" },
      { results: ["c"], has_more: true, next_cursor: "2" },
      { results: ["d"], has_more: false, next_cursor: null },
    ];
    const seen: Array<string | null | undefined> = [];
    const items = await collectPaginated<{ start_cursor?: string | null }, string>(async (args) => {
      seen.push(args.start_cursor);
      return pages[seen.length - 1]!;
    });

    expect(items).toEqual(["a", "b", "c", "d"]);
    expect(seen).toEqual([undefined, "1", "2"]);
  });

  test("stops at has_more: false even if a cursor is still present", async () => {
    const items = await collectPaginated<{ start_cursor?: string | null }, string>(async () => ({
      results: ["only"],
      has_more: false,
      next_cursor: "ignored",
    }));
    expect(items).toEqual(["only"]);
  });
});
