import { spawn } from "node:child_process";

// Single source of truth for the Notion API version across the whole tool.
// Bumped to 2026-03-11 (required by typed-database creation via tools/run);
// all other endpoints we call accept it too.
export const NOTION_API_VERSION = "2026-03-11";

interface NtnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runNtn(env: string, args: string[], stdin?: string): Promise<NtnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ntn", ["--env", env, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to spawn \`ntn\`. Is it installed and on PATH? (${err.message})`,
        ),
      );
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export async function ntnApi<T>(
  env: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const args = ["api", "-X", method, path, "--notion-version", NOTION_API_VERSION];
  const stdin = body === undefined ? undefined : JSON.stringify(body);
  const res = await runNtn(env, args, stdin);
  if (res.code !== 0) {
    throw new Error(
      `ntn api ${method} ${path} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  if (!res.stdout.trim()) return {} as T;
  return JSON.parse(res.stdout) as T;
}
