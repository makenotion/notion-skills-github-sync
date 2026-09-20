import { describe, expect, test } from "bun:test";
import { SetupSession } from "../src/web/actions.ts";
import { createFetchHandler, parseArgs } from "../src/web/server.ts";

const TOKEN = "test-token-abc123";

function handler() {
  return createFetchHandler(new SetupSession("dev"), TOKEN);
}

describe("parseArgs", () => {
  test("uses safe defaults", () => {
    const a = parseArgs([]);
    expect(a.env).toBe("prod");
    expect(a.port).toBe(4517);
    expect(a.open).toBe(true);
  });

  test("reads --env, --port and --no-open", () => {
    const a = parseArgs(["--env", "dev", "--port", "5000", "--no-open"]);
    expect(a.env).toBe("dev");
    expect(a.port).toBe(5000);
    expect(a.open).toBe(false);
  });
});

describe("api authentication", () => {
  test("rejects /api requests without the token", async () => {
    const res = await handler()(new Request("http://127.0.0.1/api/state"));
    expect(res.status).toBe(401);
  });

  test("accepts the token via header", async () => {
    const res = await handler()(
      new Request("http://127.0.0.1/api/state", {
        headers: { "x-setup-token": TOKEN },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { step: string } };
    expect(body.ok).toBe(true);
    expect(body.data.step).toBe("welcome");
  });

  test("accepts the token via query param (for the launch link)", async () => {
    const res = await handler()(
      new Request(`http://127.0.0.1/api/state?token=${TOKEN}`),
    );
    expect(res.status).toBe(200);
  });
});

describe("action guards", () => {
  test("pat-info fails before the skills repo exists", async () => {
    const res = await handler()(
      new Request("http://127.0.0.1/api/pat-info", {
        headers: { "x-setup-token": TOKEN },
      }),
    );
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("eject builds a prompt even before any step has run", async () => {
    const res = await handler()(
      new Request("http://127.0.0.1/api/eject", {
        headers: { "x-setup-token": TOKEN },
      }),
    );
    const body = (await res.json()) as { ok: boolean; data: { prompt: string } };
    expect(body.ok).toBe(true);
    expect(body.data.prompt).toContain("notion-skills-github-sync");
  });
});

describe("static assets", () => {
  test("serves the index page without a token", async () => {
    const res = await handler()(new Request("http://127.0.0.1/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Skills Sync");
  });
});
