import { spawn } from "node:child_process";
import type { WizardLogger } from "./logger.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
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
  logger: WizardLogger,
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

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const result = await exec("which", [cmd]);
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
