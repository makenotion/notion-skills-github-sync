import { afterEach, describe, expect, test } from "bun:test";
import {
  notionApiBaseUrl,
  NotionSkillsApi,
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
            skill_directories: [directory],
          },
        ],
        next_cursor: null,
        has_more: false,
        type: "plugin",
      },
    }));

    const plugins = await new NotionSkillsApi("dev", "ntn_secret").listPlugins();

    expect(calls[0]!.url).toBe("https://api-dev.notion.com/v1/skills/plugins");
    expect(calls[0]!.headers.Authorization).toBe("Bearer ntn_secret");
    expect(calls[0]!.headers["Notion-Version"]).toBe(SKILLS_API_VERSION);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.skill_directories[0]!.version_id).toBe("a".repeat(64));
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

    expect(calls[0]!.url).toBe(`https://api.notion.com/v1/skills/directories/${directory.id}`);
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
});
