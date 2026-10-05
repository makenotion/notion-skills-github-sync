// One-click GitHub App creation via the App Manifest flow, so the sync pushes
// as an App owned by the org rather than with one person's PAT.
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//
//   1. A throwaway localhost page auto-POSTs a manifest to GitHub's "new App" form.
//   2. The user clicks "Create GitHub App"; GitHub redirects back with a code.
//   3. We exchange the code for the App's id + private key (no auth needed).
//   4. The user installs the App on the skills repo; we poll until it shows up.

import * as p from "@clack/prompts";
import pc from "picocolors";
import { randomBytes } from "node:crypto";
import { loggedExec, openInBrowser } from "../exec.ts";
import { spinner } from "../spinner.ts";
import type { SetupLogger } from "../logger.ts";
import {
  createAppJwt,
  findInstallationId,
  mintInstallationToken,
} from "../../src/target/github-app.ts";

export interface GitHubAppResult {
  appId: string;
  slug: string;
  privateKey: string;
  installationId: string;
}

/** GitHub caps App names at 34 chars, and they're globally unique. */
export function defaultAppName(skillsRepo: string): string {
  const owner = skillsRepo.split("/")[0] ?? "";
  return `Notion Skills Sync ${owner}`.slice(0, 34).trim();
}

export function buildManifest(skillsRepo: string, redirectUrl: string) {
  return {
    name: defaultAppName(skillsRepo),
    url: "https://github.com/makenotion/notion-skills-github-sync",
    description: `Publishes Notion skills to ${skillsRepo}.`,
    redirect_url: redirectUrl,
    public: false,
    // Contents:write is all the Git Data API push needs (metadata:read is implied).
    default_permissions: { contents: "write" },
    default_events: [],
    hook_attributes: { url: "https://example.com/unused", active: false },
  };
}

export function newAppFormUrl(owner: string, isOrg: boolean, state: string): string {
  const base = isOrg
    ? `https://github.com/organizations/${owner}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function ownerIsOrg(logger: SetupLogger, owner: string): Promise<boolean> {
  const r = await loggedExec(logger, "credentials", "gh", ["api", `users/${owner}`, "--jq", ".type"]);
  return r.code === 0 && r.stdout.trim() === "Organization";
}

/**
 * Run the manifest flow end to end. Returns null if the user cancels or a step
 * times out (the caller can fall back to a PAT).
 */
export async function createGitHubApp(
  logger: SetupLogger,
  skillsRepo: string,
): Promise<GitHubAppResult | null> {
  const owner = skillsRepo.split("/")[0]!;
  const isOrg = await ownerIsOrg(logger, owner);
  const state = randomBytes(16).toString("hex");

  let resolveCode!: (code: string) => void;
  const codePromise = new Promise<string>((r) => (resolveCode = r));
  let installUrl = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        const manifest = buildManifest(skillsRepo, `http://127.0.0.1:${server.port}/callback`);
        const action = newAppFormUrl(owner, isOrg, state);
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<body style="font-family:system-ui;padding:2rem">
<p>Sending you to GitHub to create the <b>${escapeHtml(manifest.name)}</b> App…</p>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button>Continue to GitHub</button></form>
<script>document.getElementById("f").submit()</script></body>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.get("state") !== state) {
          return new Response("State mismatch — rerun setup.", { status: 400 });
        }
        resolveCode(code);
        return new Response(
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">
<p>App created. Return to your terminal — it will open the install page next.</p></body>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });

  try {
    const startUrl = `http://127.0.0.1:${server.port}/`;
    p.log.info(
      `We'll open GitHub's "Register new GitHub App" form, pre-filled:\n` +
        `  1. Review the name (must be globally unique — edit it if GitHub complains)\n` +
        `  2. Click ${pc.bold("Create GitHub App")}\n` +
        pc.dim(isOrg ? `  (Creating it under the ${owner} org needs org-owner or App-manager rights.)` : ""),
    );
    await openInBrowser(logger, "credentials", startUrl);
    p.log.message(pc.dim(`If the page didn't open: ${startUrl}`));

    const waitSpinner = spinner();
    waitSpinner.start("Waiting for you to create the App on GitHub...");
    const code = await Promise.race([
      codePromise,
      new Promise<null>((r) => setTimeout(() => r(null), 10 * 60_000)),
    ]);
    if (!code) {
      waitSpinner.stop("Timed out waiting for the App to be created.");
      return null;
    }

    // Exchange the one-time code (valid 1h) for the App's credentials.
    const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "notion-skills-github-sync" },
    });
    const text = await res.text();
    if (!res.ok) {
      waitSpinner.stop(`GitHub rejected the manifest code (${res.status}).`);
      logger.event("github-app-conversion-failed", { status: res.status, body: text });
      return null;
    }
    const app = JSON.parse(text) as { id: number; slug: string; pem: string };
    logger.registerSecret(app.pem);
    logger.event("github-app-created", { appId: app.id, slug: app.slug });
    waitSpinner.stop(`GitHub App ${pc.cyan(app.slug)} created (id ${app.id}).`);

    // --- Install on the skills repo ---
    installUrl = `https://github.com/apps/${app.slug}/installations/new`;
    p.log.info(
      `Now install it on the skills repo:\n` +
        `  1. Choose ${pc.bold(owner)}\n` +
        `  2. Pick ${pc.bold("Only select repositories")} → ${pc.cyan(skillsRepo)}\n` +
        `  3. Click ${pc.bold("Install")}`,
    );
    await openInBrowser(logger, "credentials", installUrl);
    p.log.message(pc.dim(`If the page didn't open: ${installUrl}`));

    const installSpinner = spinner();
    installSpinner.start(`Waiting for the App to be installed on ${skillsRepo}...`);
    let installationId: string | null = null;
    for (let i = 0; i < 200 && !installationId; i++) {
      // A fresh JWT each poll: they're only valid for ~10 minutes.
      installationId = await findInstallationId(createAppJwt(String(app.id), app.pem), skillsRepo).catch(
        () => null,
      );
      if (!installationId) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!installationId) {
      installSpinner.stop("App not installed on the skills repo yet.");
      return null;
    }

    // Prove it end to end: mint a repo-scoped token, check push permission.
    const token = await mintInstallationToken({ appId: String(app.id), privateKey: app.pem }, skillsRepo);
    logger.registerSecret(token);
    installSpinner.stop(`Installed (installation ${installationId}) — the App can push to ${skillsRepo}.`);
    return { appId: String(app.id), slug: app.slug, privateKey: app.pem, installationId };
  } finally {
    server.stop(true);
  }
}
