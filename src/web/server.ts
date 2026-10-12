#!/usr/bin/env bun
/**
 * Local visual setup wizard — a GUI front-end to the setup CLI.
 *
 * Boots a tiny server bound to loopback (127.0.0.1) and opens the browser to a
 * Notion-styled, step-by-step wizard. All side effects (ntn / gh / git / bun)
 * run server-side via `SetupSession` (src/web/actions.ts), which reuses the
 * same building-block helpers as the CLI. The browser is just the front-end.
 *
 *   bun run src/web/server.ts [--env dev|stg|prod] [--port N] [--no-open]
 *
 * Security: the server binds to loopback only and requires a per-session token
 * (printed in the launch URL) on every /api/* request, so another local
 * process can't drive the wizard or read the (redacted) diagnostic log.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SetupSession } from "./actions.ts";
import { buildEjectPrompt } from "./agent-prompt.ts";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

export interface CliArgs {
  env: string;
  port: number;
  open: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const env = argv.includes("--env") ? argv[argv.indexOf("--env") + 1] : undefined;
  const portArg = argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : undefined;
  return {
    env: env || "prod",
    port: portArg ? Number(portArg) : 4517,
    open: !argv.includes("--no-open"),
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort — the URL is always printed too */
  }
}

function isAuthed(req: Request, token: string): boolean {
  const url = new URL(req.url);
  return (
    req.headers.get("x-setup-token") === token ||
    url.searchParams.get("token") === token
  );
}

async function handleApi(
  session: SetupSession,
  token: string,
  path: string,
  req: Request,
): Promise<Response> {
  if (!isAuthed(req, token)) return json({ ok: false, error: "Unauthorized" }, 401);

  switch (path) {
    case "/api/state":
      return json({ ok: true, data: { state: session.state, step: session.currentStep } });

    case "/api/preflight":
      return json(await session.preflight());

    case "/api/create-db": {
      const body = await readBody(req);
      const dbName = String(body.dbName || "Skills").trim() || "Skills";
      return json(await session.createDatabase(dbName));
    }

    case "/api/create-repos": {
      const body = await readBody(req);
      return json(
        await session.createRepos({
          skillsRepo: String(body.skillsRepo || "").trim(),
          skillsRepoIsNew: body.skillsRepoIsNew !== false,
          syncRepo: String(body.syncRepo || "").trim(),
          syncRepoIsNew: body.syncRepoIsNew !== false,
        }),
      );
    }

    case "/api/pat-info":
      return json(session.patInfo());

    case "/api/notion-connection-info":
      return json(session.notionConnectionInfo());

    case "/api/validate-github-token": {
      const body = await readBody(req);
      return json(await session.validateGithubToken(String(body.token || "")));
    }

    case "/api/validate-notion-token": {
      const body = await readBody(req);
      return json(await session.validateNotionToken(String(body.token || "")));
    }

    case "/api/deploy":
      return json(await session.deploy());

    case "/api/wrapup":
      return json(session.wrapup());

    case "/api/eject": {
      const logPath = session.logger.getPath();
      let logContents = "";
      try {
        logContents = readFileSync(logPath, "utf-8");
      } catch {
        /* log may not be flushed yet */
      }
      session.logger.event("eject-to-agent", { step: session.currentStep });
      const prompt = buildEjectPrompt({ logPath, currentStep: session.currentStep, logContents });
      return json({ ok: true, data: { prompt, logPath, logContents } });
    }

    default:
      return json({ ok: false, error: "Not found" }, 404);
  }
}

/**
 * Build the request handler for a session. Exposed (with its token) so it can
 * be exercised in tests without binding a socket or opening a browser.
 */
export function createFetchHandler(
  session: SetupSession,
  token: string,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) return handleApi(session, token, path, req);

    const asset = STATIC[path];
    if (asset) {
      const file = Bun.file(UI_DIR + asset.file);
      if (await file.exists()) {
        return new Response(file, { headers: { "content-type": asset.type } });
      }
    }
    return new Response("Not found", { status: 404 });
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const token = randomUUID();
  const session = new SetupSession(args.env);
  const handler = createFetchHandler(session, token);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: args.port,
    fetch: handler,
  });

  const launchUrl = `http://127.0.0.1:${server.port}/?token=${token}`;
  console.log("");
  console.log("  Notion Skills → GitHub Sync — visual setup");
  console.log("  ─────────────────────────────────────────");
  console.log(`  Environment: ${args.env}`);
  console.log("  Open this URL in your browser:");
  console.log("");
  console.log(`    ${launchUrl}`);
  console.log("");
  console.log("  Keep this terminal open while you complete setup. Press Ctrl+C to stop.");
  console.log("");

  if (args.open) openBrowser(launchUrl);
}

if (import.meta.main) main();
