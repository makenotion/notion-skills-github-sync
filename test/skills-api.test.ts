import { afterEach, describe, expect, test } from "bun:test";
import {
  notionApiBaseUrl,
  NotionSkillsApi,
  rateLimitDelayMs,
  SKILLS_API_VERSION,
} from "../src/notion/skills-api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(
  respond: (url: string) => { status?: number; body: unknown },
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const { status = 200, body } = respond(url);
    return new Response(JSON.stringify(body), {
      status,
      statusText: status === 200 ? "OK" : "Error",
    });
  }) as typeof fetch;
  return calls;
}

describe("notionApiBaseUrl", () => {
  test("maps prod and non-prod envs", () => {
    expect(notionApiBaseUrl("prod")).toBe("https://api.notion.com");
    expect(notionApiBaseUrl("dev")).toBe("https://api-dev.notion.com");
    expect(notionApiBaseUrl("stg")).toBe("https://api-stg.notion.com");
  });
});

describe("NotionSkillsApi", () => {
  const directory = {
    id: "3a74d95e-c30f-80eb-964d-c2c2631d2867",
    name: "meeting-notes",
    description: "Structure meeting notes.",
    updated_at: "2026-07-24T18:15:57.000Z",
    version_id: "a".repeat(64),
  };

  test("listPlugins sends auth + version headers and returns results", async () => {
    const calls = stubFetch(() => ({
      body: {
        object: "list",
        results: [
          {
            id: "notion-workspace-skills",
            name: "Notion Workspace Skills",
            description: "Skills managed by Notion",
            version_id: "b".repeat(64),
            skills: [directory],
          },
        ],
        next_cursor: null,
        has_more: false,
        type: "plugin",
      },
    }));

    const plugins = await new NotionSkillsApi("dev", "ntn_secret").listPlugins();

    expect(calls[0]!.url).toBe("https://api-dev.notion.com/v1/ai/plugins");
    expect(calls[0]!.headers.Authorization).toBe("Bearer ntn_secret");
    expect(calls[0]!.headers["Notion-Version"]).toBe(SKILLS_API_VERSION);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.skills[0]!.version_id).toBe("a".repeat(64));
  });

  test("listPlugins follows the cursor across pages", async () => {
    const page = (id: string, cursor: string | null) => ({
      object: "list",
      results: [
        { id, name: id, description: "", version_id: "c".repeat(64), skills: [directory] },
      ],
      next_cursor: cursor,
      has_more: cursor !== null,
    });
    const calls = stubFetch((url) => ({
      body: url.includes("start_cursor=cur2") ? page("second", null) : page("first", "cur2"),
    }));

    const plugins = await new NotionSkillsApi("dev", "t").listPlugins();

    expect(calls.map((c) => c.url)).toEqual([
      "https://api-dev.notion.com/v1/ai/plugins",
      "https://api-dev.notion.com/v1/ai/plugins?start_cursor=cur2",
    ]);
    expect(plugins.map((p) => p.id)).toEqual(["first", "second"]);
  });

  test("listPlugins tolerates a response with no results array", async () => {
    stubFetch(() => ({ body: {} }));
    expect(await new NotionSkillsApi("prod", "t").listPlugins()).toEqual([]);
  });

  test("getDirectoryArchive returns the signed URL", async () => {
    const calls = stubFetch(() => ({
      body: { id: directory.id, version_id: directory.version_id, url: "https://s3/signed" },
    }));

    const archive = await new NotionSkillsApi("prod", "t").getDirectoryArchive(directory.id);

    expect(calls[0]!.url).toBe(`https://api.notion.com/v1/ai/skills/${directory.id}`);
    expect(archive.url).toBe("https://s3/signed");
  });

  // The endpoints sit behind the `public_api_skills_plugins` gate, and a
  // workspace without it gets the same 403 as a token missing read access —
  // so the error has to name both possibilities or it's a dead end.
  test("403 restricted_resource names the feature gate and the token", async () => {
    stubFetch(() => ({
      status: 403,
      body: { object: "error", status: 403, code: "restricted_resource", message: "Endpoint unavailable." },
    }));

    const err = await new NotionSkillsApi("dev", "t").listPlugins().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("public_api_skills_plugins");
    expect((err as Error).message).toContain("dev");
    expect((err as Error).message).toContain("NOTION_API_TOKEN");
  });

  test("401 points at the token", async () => {
    stubFetch(() => ({ status: 401, body: { code: "unauthorized" } }));
    const err = await new NotionSkillsApi("prod", "t").listPlugins().catch((e: Error) => e);
    expect((err as Error).message).toContain("NOTION_API_TOKEN is missing or invalid");
  });

  test("other failures surface the status and body", async () => {
    stubFetch(() => ({ status: 500, body: { message: "boom" } }));
    const err = await new NotionSkillsApi("prod", "t").listPlugins().catch((e: Error) => e);
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).toContain("boom");
  });

  // The documented budget is ~3 requests/second, so a cold sync fetching
  // hundreds of archives can legitimately be told to slow down.
  test("a 429 is retried and then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ code: "rate_limited" }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;

    expect(await new NotionSkillsApi("dev", "t").listPlugins()).toEqual([]);
    expect(calls).toBe(2);
  });

  test("a persistent 429 eventually gives up with the API's message", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
      calls++;
      return new Response(JSON.stringify({ code: "rate_limited" }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as typeof fetch;

    const err = await new NotionSkillsApi("dev", "t").listPlugins().catch((e: Error) => e);
    expect((err as Error).message).toContain("429");
    expect(calls).toBe(4); // initial attempt + MAX_RETRIES
  });
});

describe("rateLimitDelayMs", () => {
  const res = (status: number, h: Record<string, string> = {}) => ({
    status,
    headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
  });

  test("uses Retry-After when present", () => {
    expect(rateLimitDelayMs(res(429, { "retry-after": "2" }))).toBe(2_250);
    // "retry after 0 seconds" means now, and must not be read as a missing header.
    expect(rateLimitDelayMs(res(429, { "retry-after": "0" }))).toBe(250);
  });

  test("falls back to a short pause without the header", () => {
    expect(rateLimitDelayMs(res(429))).toBe(1_000);
  });

  // Notion documents 529 (overloaded) as needing the same treatment as 429.
  test("529 is treated like 429", () => {
    expect(rateLimitDelayMs(res(529))).toBe(1_000);
  });

  test("other statuses are not retried", () => {
    expect(rateLimitDelayMs(res(403))).toBeNull();
    expect(rateLimitDelayMs(res(500))).toBeNull();
  });

  test("waits are capped", () => {
    expect(rateLimitDelayMs(res(429, { "retry-after": "9999" }))).toBe(60_000);
  });
});
