import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toBytes, type FileContent } from "./diff.ts";

const execFileAsync = promisify(execFile);

async function resolveToken(explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const t = stdout.trim();
    if (t) return t;
  } catch {
    // fall through
  }
  throw new Error(
    "No GitHub token: set GITHUB_TOKEN or authenticate with `gh auth login`.",
  );
}

interface TreeEntryInput {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null; // null => delete
}

export interface TreeFile {
  sha: string;
  type: string;
}

export class GitHubRepo {
  private tokenPromise: Promise<string>;
  constructor(
    private readonly repo: string, // "owner/name"
    token: string | undefined,
  ) {
    this.tokenPromise = resolveToken(token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokenPromise;
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "notion-skills-github-sync",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) {
      throw new HttpError(404, `${method} ${path} -> 404`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, `${method} ${path} -> ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private base() {
    return `/repos/${this.repo}`;
  }

  async getDefaultBranch(): Promise<string> {
    const r = await this.request<{ default_branch: string }>("GET", this.base());
    return r.default_branch;
  }

  /**
   * Head commit sha of a branch, or null if there's no such head. 404 => the
   * branch doesn't exist; 409 "Git Repository is empty" => the repo has no
   * commits at all (a freshly-created, un-seeded repo). Both mean "no base".
   */
  async getBranchHead(branch: string): Promise<string | null> {
    try {
      const r = await this.request<{ object: { sha: string } }>(
        "GET",
        `${this.base()}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      return r.object.sha;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 409)) {
        return null;
      }
      throw e;
    }
  }

  async getCommitTreeSha(commitSha: string): Promise<string> {
    const r = await this.request<{ tree: { sha: string } }>(
      "GET",
      `${this.base()}/git/commits/${commitSha}`,
    );
    return r.tree.sha;
  }

  /**
   * getCommitTreeSha, but tolerant of the brief window right after seeding a
   * previously-empty repo: GitHub can still 409 "Git Repository is empty" on
   * the Git Data API for a second or two after the Contents API created the
   * first commit. Polling here also confirms the Git Data API is ready for the
   * blob/tree/commit writes that follow.
   */
  async awaitCommitTreeSha(
    commitSha: string,
    attempts = 8,
    delayMs = 1500,
  ): Promise<string> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.getCommitTreeSha(commitSha);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Commit ${commitSha} never became readable.`);
  }

  /** Full recursive file listing of a tree: path -> {sha, type}. */
  async getTreeFiles(treeSha: string): Promise<Map<string, TreeFile>> {
    const r = await this.request<{
      tree: Array<{ path: string; type: string; sha: string }>;
      truncated: boolean;
    }>("GET", `${this.base()}/git/trees/${treeSha}?recursive=1`);
    if (r.truncated) {
      throw new Error(
        "GitHub tree response was truncated; repo too large for recursive read.",
      );
    }
    const map = new Map<string, TreeFile>();
    for (const e of r.tree) {
      if (e.type === "blob") map.set(e.path, { sha: e.sha, type: e.type });
    }
    return map;
  }

  /** File content at a ref, or null if absent. */
  async getFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const r = await this.request<{ content: string; encoding: string }>(
        "GET",
        `${this.base()}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      );
      return Buffer.from(r.content, r.encoding as BufferEncoding).toString("utf8");
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async createBlob(content: FileContent): Promise<string> {
    const r = await this.request<{ sha: string }>("POST", `${this.base()}/git/blobs`, {
      content: toBytes(content).toString("base64"),
      encoding: "base64",
    });
    return r.sha;
  }

  // Create a tree. When baseTreeSha is undefined (an empty repo with no
  // commits), omit base_tree so GitHub builds the tree from scratch — deletions
  // in `entries` (sha: null) are meaningless there but harmless.
  async createTree(
    baseTreeSha: string | undefined,
    entries: TreeEntryInput[],
  ): Promise<string> {
    const r = await this.request<{ sha: string }>("POST", `${this.base()}/git/trees`, {
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
      tree: entries,
    });
    return r.sha;
  }

  async createCommit(opts: {
    message: string;
    treeSha: string;
    parents: string[];
    authorName: string;
    authorEmail: string;
  }): Promise<string> {
    const r = await this.request<{ sha: string }>("POST", `${this.base()}/git/commits`, {
      message: opts.message,
      tree: opts.treeSha,
      parents: opts.parents,
      author: { name: opts.authorName, email: opts.authorEmail },
    });
    return r.sha;
  }

  async updateBranch(branch: string, sha: string, force = true): Promise<void> {
    await this.request("PATCH", `${this.base()}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha,
      force,
    });
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    await this.request("POST", `${this.base()}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  /**
   * Seed the very first commit on `branch` via the Contents API. The Git Data
   * API (blobs/trees/commits) refuses to operate on a repo with zero commits
   * ("Git Repository is empty", 409), but the Contents API can bootstrap one —
   * so an un-seeded repo gets a base commit here and the normal Git Data flow
   * takes over afterward. Returns the new commit sha.
   */
  async seedInitialCommit(branch: string): Promise<string> {
    const name = this.repo.split("/")[1] ?? this.repo;
    const content = Buffer.from(
      `# ${name}\n\nSkills marketplace synced from Notion.\n`,
    ).toString("base64");
    const r = await this.request<{ commit: { sha: string } }>(
      "PUT",
      `${this.base()}/contents/README.md`,
      { message: "Initial commit", content, branch },
    );
    return r.commit.sha;
  }

  webBranchUrl(branch: string): string {
    return `https://github.com/${this.repo}/tree/${encodeURIComponent(branch)}`;
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// Build tree entries from a change set. Blobs are already uploaded (we only
// pass their shas here), so text vs binary doesn't matter at this layer.
export function toTreeEntries(
  create: Array<{ path: string; sha: string }>,
  deletePaths: string[],
): TreeEntryInput[] {
  return [
    ...create.map((c) => ({ path: c.path, mode: "100644" as const, type: "blob" as const, sha: c.sha })),
    ...deletePaths.map((p) => ({ path: p, mode: "100644" as const, type: "blob" as const, sha: null })),
  ];
}
