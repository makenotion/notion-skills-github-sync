// The `ntn` CLI, as setup uses it. Setup is the only half of this tool that
// shells out to a CLI at all — the sync talks plain HTTPS — so everything
// ntn-shaped lives here and nothing under src/ imports it.

import { commandExists, loggedExec, type ExecResult } from "./exec.ts";
import type { SetupLogger } from "./logger.ts";

// Single source of truth for the Notion API version setup sends. All setup
// calls, including typed database creation via POST /v1/databases, use it.
export const NOTION_API_VERSION = "2026-03-11";

const INSTALL_COMMAND = "curl -fsSL https://ntn.dev | bash";

/** argv for `ntn api` against one env, with the version pinned. */
export function ntnApiArgs(
  notionEnv: string,
  method: string,
  path: string,
): string[] {
  return [
    "--env", notionEnv,
    "api", "-X", method, path,
    "--notion-version", NOTION_API_VERSION,
  ];
}

export type NtnInstall =
  | { status: "present" }
  | { status: "installed" }
  | { status: "failed"; stderr: string; command: string };

/**
 * Install `ntn` if it isn't on PATH. `onInstalling` fires only when an install
 * actually starts, so the caller can open a spinner (interactive) or print a
 * line (CI) without announcing work that never happens.
 */
export async function ensureNtnInstalled(
  logger: SetupLogger,
  step: string,
  onInstalling?: () => void,
): Promise<NtnInstall> {
  if (await commandExists("ntn")) return { status: "present" };
  onInstalling?.();
  const result = await loggedExec(logger, step, "bash", ["-c", INSTALL_COMMAND]);
  if (result.code !== 0) {
    return { status: "failed", stderr: result.stderr, command: INSTALL_COMMAND };
  }
  return { status: "installed" };
}

/**
 * Probe whether `ntn` is authenticated. `ntn whoami` doesn't exist in current
 * versions, so this calls the authenticated `GET /v1/users/me` instead — the
 * response body also carries the account name, which the interactive flow
 * echoes back to the user.
 */
export function probeNtnAuth(
  logger: SetupLogger,
  step: string,
  notionEnv: string,
): Promise<ExecResult> {
  return loggedExec(
    logger,
    step,
    "ntn",
    ntnApiArgs(notionEnv, "GET", "/v1/users/me"),
  );
}
