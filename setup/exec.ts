// Subprocess plumbing for setup: run a command, capture it, log it. Setup
// drives `ntn`, `gh` and `git` this way; every exec that matters is recorded in
// the diagnostic log so a stuck run can be read back afterwards.

import { spawn } from "node:child_process";
import type { SetupLogger } from "./logger.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
}

export function exec(
  command: string,
  args: string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      reject(new Error(`Failed to run \`${command}\`: ${err.message}`));
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts?.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

export async function loggedExec(
  logger: SetupLogger,
  step: string,
  command: string,
  args: string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  const start = Date.now();
  const cmdStr = [command, ...args].join(" ");
  // Log the start too, so a hang/crash mid-command is attributable to it.
  logger.event("exec-start", { step, command: cmdStr });
  try {
    const result = await exec(command, args, opts);
    logger.log({
      timestamp: new Date().toISOString(),
      step,
      command: cmdStr,
      exitCode: result.code,
      stdout: result.stdout.slice(0, 2000),
      stderr: result.stderr.slice(0, 2000),
      duration_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    logger.log({
      timestamp: new Date().toISOString(),
      step,
      command: cmdStr,
      exitCode: null,
      diagnostics: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    });
    throw err;
  }
}

/** Open a URL in the user's default browser (best-effort — the URL is always also printed). */
export async function openInBrowser(
  logger: SetupLogger,
  step: string,
  url: string,
): Promise<boolean> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const result = await loggedExec(logger, step, opener, [url]);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const result = await exec("which", [cmd]);
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Ordered clipboard-copy command candidates for a platform — the first one that
 * both exists and succeeds wins. Linux/BSD has no single blessed tool, so we try
 * Wayland's `wl-copy` first, then the two common X11 utilities. Kept pure (takes
 * the platform, returns command+args) so the ordering is unit-testable without a
 * real clipboard.
 */
export function clipboardCommands(platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ];
}

/**
 * Best-effort copy of `text` to the OS clipboard. Returns true only if a tool
 * actually accepted it — callers use that to decide whether to tell the user
 * "we copied it for you" (never a hard dependency; the value is always printed
 * too).
 */
export async function copyToClipboard(
  logger: SetupLogger,
  step: string,
  text: string,
): Promise<boolean> {
  for (const [cmd, ...args] of clipboardCommands(process.platform)) {
    if (!cmd || !(await commandExists(cmd))) continue;
    try {
      const result = await loggedExec(logger, step, cmd, args, { stdin: text });
      if (result.code === 0) return true;
    } catch {
      // Tool exists but failed (e.g. no display server) — try the next one.
    }
  }
  return false;
}

/**
 * `owner/name` out of a `git remote get-url` result, for both the ssh and https
 * forms. Excluding `.` and whitespace from the name is what strips a trailing
 * `.git` and the command's trailing newline.
 */
export function parseGithubRepo(remoteUrl: string): string | null {
  return remoteUrl.match(/github\.com[/:]([^/]+\/[^/.\s]+)/)?.[1] ?? null;
}
