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

  /** Head commit sha of a branch, or null if the branch doesn't exist. */
  async getBranchHead(branch: string): Promise<string | null> {
    try {
      const r = await this.request<{ object: { sha: string } }>(
        "GET",
        `${this.base()}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      return r.object.sha;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
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

  async createTree(baseTreeSha: string, entries: TreeEntryInput[]): Promise<string> {
    const r = await this.request<{ sha: string }>("POST", `${this.base()}/git/trees`, {
      base_tree: baseTreeSha,
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
