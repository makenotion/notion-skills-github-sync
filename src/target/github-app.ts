// GitHub App authentication: mint a short-lived installation token from the
// App's id + private key, so the sync isn't tied to one person's account (the
// problem with a fine-grained PAT: it belongs to — and expires with — a user).
//
// Flow (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app):
//   1. Sign a 10-minute RS256 JWT as the App.
//   2. Find the App's installation on the target repo (or use a given id).
//   3. Exchange the JWT for a 1-hour installation token scoped to that repo.
// A sync is minutes long, so one token per run is enough; no refresh logic.

import { createSign } from "node:crypto";

export interface GitHubAppCredentials {
  appId: string;
  /** PEM. Literal "\n" escapes are accepted, so it fits on one .env line. */
  privateKey: string;
  /** Optional: skips the repo -> installation lookup. */
  installationId?: string | undefined;
}

const API = "https://api.github.com";
const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "notion-skills-github-sync",
};

/** `.env` and repo secrets mangle multi-line values; accept `\n`-escaped PEMs. */
export function normalizePrivateKey(raw: string): string {
  const key = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  return key.trim() + "\n";
}

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** RS256 App JWT. `iat` is backdated 60s to absorb clock drift, per GitHub's docs. */
export function createAppJwt(appId: string, privateKey: string, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = b64url(signer.sign(normalizePrivateKey(privateKey)));
  return `${header}.${payload}.${signature}`;
}

async function appRequest<T>(jwt: string, method: string, path: string): Promise<{ status: number; body: T | string }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...HEADERS, Authorization: `Bearer ${jwt}` },
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: text };
  return { status: res.status, body: JSON.parse(text) as T };
}

/** The App's installation id on `repo`, or null if the App isn't installed there. */
export async function findInstallationId(jwt: string, repo: string): Promise<string | null> {
  const r = await appRequest<{ id: number }>(jwt, "GET", `/repos/${repo}/installation`);
  if (r.status === 404) return null;
  if (typeof r.body === "string") {
    throw new Error(`GitHub App: GET /repos/${repo}/installation -> ${r.status}: ${r.body}`);
  }
  return String(r.body.id);
}

/** Mint an installation access token for `repo` (scoped to that one repo). */
export async function mintInstallationToken(creds: GitHubAppCredentials, repo: string): Promise<string> {
  const jwt = createAppJwt(creds.appId, creds.privateKey);
  const installationId = creds.installationId ?? (await findInstallationId(jwt, repo));
  if (!installationId) {
    throw new Error(
      `GitHub App ${creds.appId} is not installed on ${repo}.\n` +
        `  Install it (Settings → GitHub Apps on the repo owner, or https://github.com/apps/<app-slug>/installations/new)\n` +
        `  and grant it access to ${repo}.`,
    );
  }
  const name = repo.split("/")[1];
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(name ? { repositories: [name] } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `GitHub App: could not mint an installation token for ${repo} (${res.status}): ${text}\n` +
        `  Check GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY, and that the installation includes ${repo}.`,
    );
  }
  return (JSON.parse(text) as { token: string }).token;
}
