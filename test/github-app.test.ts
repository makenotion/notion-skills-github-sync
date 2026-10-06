import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  createAppJwt,
  mintInstallationToken,
  normalizePrivateKey,
} from "../src/target/github-app.ts";
import { buildManifest, defaultAppName, newAppFormUrl } from "../setup/steps/github-app.ts";
import { githubCredentialSettings } from "../setup/steps/deploy.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

describe("createAppJwt", () => {
  test("is a valid RS256 JWT issued by the App, backdated 60s, < 10 min", () => {
    const now = 1_700_000_000_000;
    const jwt = createAppJwt("12345", PEM, now);
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(fromB64url(h!).toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(fromB64url(p!).toString());
    expect(payload).toEqual({ iss: "12345", iat: now / 1000 - 60, exp: now / 1000 + 540 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, fromB64url(sig!))).toBe(true);
  });

  test("accepts a one-line, \\n-escaped key (the .env form)", () => {
    const oneLine = PEM.trim().replace(/\n/g, "\\n");
    expect(normalizePrivateKey(oneLine)).toBe(normalizePrivateKey(PEM));
    expect(() => createAppJwt("1", oneLine)).not.toThrow();
  });
});

describe("mintInstallationToken", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("looks up the repo's installation, then mints a repo-scoped token", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined });
      if (url.endsWith("/repos/acme/skills/installation")) return new Response(JSON.stringify({ id: 99 }));
      if (url.endsWith("/app/installations/99/access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_abc" }), { status: 201 });
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const token = await mintInstallationToken({ appId: "1", privateKey: PEM }, "acme/skills");
    expect(token).toBe("ghs_abc");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ repositories: ["skills"] });
  });

  test("explains when the App isn't installed on the repo", async () => {
    globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    await expect(mintInstallationToken({ appId: "7", privateKey: PEM }, "acme/skills")).rejects.toThrow(
      /not installed on acme\/skills/,
    );
  });
});

describe("loadConfig GitHub App settings", () => {
  const OWNED = ["GITHUB_REPO", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"];
  const clear = () => OWNED.forEach((n) => delete process.env[n]);
  beforeEach(clear);
  afterEach(clear);
  const cwd = mkdtempSync(join(tmpdir(), "skills-app-config-"));
  const load = () => loadConfig({ cwd, warn: () => {} });

  test("absent -> no app (PAT / gh fallback)", () => {
    process.env.GITHUB_REPO = "acme/skills";
    expect(load().github.app).toBeUndefined();
  });

  test("both set -> app credentials", () => {
    process.env.GITHUB_REPO = "acme/skills";
    process.env.GITHUB_APP_ID = "42";
    process.env.GITHUB_APP_PRIVATE_KEY = "key";
    expect(load().github.app).toEqual({ appId: "42", privateKey: "key", installationId: undefined });
  });

  test("half-set is an error, not a silent PAT fallback", () => {
    process.env.GITHUB_REPO = "acme/skills";
    process.env.GITHUB_APP_ID = "42";
    expect(load).toThrow(/GITHUB_APP_PRIVATE_KEY/);
  });
});

describe("setup: GitHub App manifest + deploy settings", () => {
  test("App name fits GitHub's 34-char limit", () => {
    expect(defaultAppName("a-very-long-organization-name/skills").length).toBeLessThanOrEqual(34);
  });

  test("manifest asks for contents:write only, no webhook", () => {
    const m = buildManifest("acme/skills", "http://127.0.0.1:1/callback");
    expect(m.default_permissions).toEqual({ contents: "write" });
    expect(m.hook_attributes.active).toBe(false);
    expect(m.public).toBe(false);
  });

  test("org vs user App form URL", () => {
    expect(newAppFormUrl("acme", true, "s")).toBe("https://github.com/organizations/acme/settings/apps/new?state=s");
    expect(newAppFormUrl("me", false, "s")).toBe("https://github.com/settings/apps/new?state=s");
  });

  test("App creds -> app id variable, key secret, one-line .env key", () => {
    const s = githubCredentialSettings({
      githubApp: { appId: "42", slug: "x", privateKey: PEM, installationId: "9" },
    });
    expect(s.variables).toEqual([["SKILLS_GITHUB_APP_ID", "42"]]);
    expect(s.secrets.map(([n]) => n)).toEqual(["SKILLS_GITHUB_APP_PRIVATE_KEY"]);
    expect(s.env.GITHUB_APP_PRIVATE_KEY).not.toContain("\n");
    expect(normalizePrivateKey(s.env.GITHUB_APP_PRIVATE_KEY!)).toBe(normalizePrivateKey(PEM));
  });

  test("PAT creds keep the old GH_PUSH_TOKEN shape", () => {
    const s = githubCredentialSettings({ githubToken: "ghp_x" });
    expect(s).toEqual({ env: { GITHUB_TOKEN: "ghp_x" }, secrets: [["GH_PUSH_TOKEN", "ghp_x"]], variables: [] });
  });
});
