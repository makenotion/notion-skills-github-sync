import { describe, expect, test } from "bun:test";
import { collectPaginated, retryDelayMs } from "../src/notion/http.ts";

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
