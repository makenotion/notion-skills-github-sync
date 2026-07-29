import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { WizardLogger } from "../wizard/logger.ts";
import { runSetupFlow } from "../wizard/index.ts";
import { SetupAbortError, buildHandoffPrompt } from "../wizard/handoff.ts";
import { openInBrowser } from "../wizard/exec.ts";
import { WebIO, type WebEvent } from "./io.ts";

export interface WebServerOptions {
  notionEnv: string;
  dbName?: string;
  /** Preferred port; 0 (default) picks a random free port. */
  port?: number;
  /** Best-effort open the browser at the session URL. */
  open?: boolean;
}

export interface RunningWebServer {
  url: string;
  port: number;
  stop(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Boot the local setup web app. A single-session, single-user server bound to
 * loopback and guarded by a random token in the URL — no other local process
 * can drive it. It runs the exact same {@link runSetupFlow} the CLI runs, with
 * a {@link WebIO} translating reporter output to SSE and prompts to HTTP.
 */
export async function startWebServer(
  opts: WebServerOptions,
): Promise<RunningWebServer> {
  const token = randomBytes(16).toString("hex");
  const logger = new WizardLogger();

  // Buffer every event so a browser that connects (or reconnects) mid-flow can
  // replay the whole transcript — the flow may start before SSE attaches.
  const events: WebEvent[] = [];
  const subscribers = new Set<(e: WebEvent) => void>();
  let lastStepLabel = "";
  let flowStarted = false;

  const emit = (event: WebEvent): void => {
    if (event.type === "reporter" && event.kind === "step") {
      lastStepLabel = event.text;
    }
    events.push(event);
    for (const sub of subscribers) {
      try {
        sub(event);
      } catch {
        /* a dead subscriber shouldn't break the others */
      }
    }
  };

  const io = new WebIO(emit);
  const appHtml = await Bun.file(join(import.meta.dir, "app.html")).text();

  const startFlow = (): void => {
    if (flowStarted) return;
    flowStarted = true;
    emit({ type: "flow", status: "running" });
    runSetupFlow(io, logger, {
      notionEnv: opts.notionEnv,
      dbName: opts.dbName,
      testRun: false,
    })
      .then((res) =>
        emit({ type: "flow", status: res.status, exitCode: res.exitCode }),
      )
      .catch((err) => {
        if (err instanceof SetupAbortError) {
          emit({ type: "flow", status: "aborted", detail: err.context.what });
        } else {
          logger.crash(err, "web");
          emit({
            type: "flow",
            status: "aborted",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => logger.finalize());
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    // SSE connections are long-lived; disable the idle timeout (a heartbeat
    // keeps the stream warm regardless).
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // Everything is gated on the session token embedded in the opened URL.
      if (url.searchParams.get("token") !== token) {
        return new Response(
          "Forbidden — open the URL printed by `setup --web` (it carries a session token).",
          { status: 403 },
        );
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(appHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        return sseResponse(events, subscribers);
      }

      if (req.method === "POST" && url.pathname === "/api/start") {
        startFlow();
        return json({ ok: true });
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/prompt/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/prompt/".length));
        let payload: { value?: unknown; cancel?: boolean } = {};
        try {
          payload = (await req.json()) as typeof payload;
        } catch {
          /* empty/invalid body → treat as empty answer */
        }
        const result = io.answer(id, payload);
        return json(result, result.ok ? 200 : 422);
      }

      if (req.method === "POST" && url.pathname === "/api/cancel") {
        io.cancelAll();
        return json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/eject") {
        const prompt = buildHandoffPrompt({
          step: lastStepLabel || "the web setup",
          what:
            "I'm running the notion-skills-github-sync setup through the local web app " +
            "and I'd like help getting unstuck.",
          logPath: logger.getPath(),
        });
        return json({ prompt, logPath: logger.getPath() });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}/?token=${token}`;

  if (opts.open) {
    // Best-effort — the URL is always printed by the caller too.
    await openInBrowser(logger, "web", url);
  }

  return {
    url,
    port: server.port ?? 0,
    stop: () => server.stop(true),
  };
}

/** Build the text/event-stream response: replay the buffer, then live-forward. */
function sseResponse(
  events: WebEvent[],
  subscribers: Set<(e: WebEvent) => void>,
): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const write = (event: WebEvent): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* stream closed */
        }
      };
      for (const event of events) write(event);
      subscribers.add(write);
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* stream closed */
        }
      }, 20000);
      cleanup = () => {
        subscribers.delete(write);
        clearInterval(heartbeat);
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
