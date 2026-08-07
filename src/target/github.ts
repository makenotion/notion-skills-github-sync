import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  gitBlobSha,
  toBytes,
  type ApplyOptions,
  type ApplyResult,
  type FileContent,
  type SyncTarget,
  type TargetChanges,
  type TargetState,
} from "./target.ts";

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

// An entry points at an uploaded blob (`sha`), carries content inline for
// GitHub to blob server-side (`content`), or deletes a path (`sha: null`).
type TreeEntryInput = {
  path: string;
  mode: "100644";
  type: "blob";
} & ({ sha: string | null } | { content: string });

export interface TreeFile {
  sha: string;
  type: string;
}

// GitHub's secondary limit: 80 content-creating requests/min, 500/hour. The
// hourly one is handled by simply making far fewer requests.
const WRITES_PER_MINUTE = 60;

// Tree requests cap at 100k entries / ~7MB. Each chunk's tree becomes the
// next chunk's base, so the final sha reflects every entry.
const TREE_CHUNK_ENTRIES = 300;
const TREE_CHUNK_BYTES = 3_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_RETRIES = 3;
// GitHub asks for a minute's pause after a secondary-limit 403 with no header.
const SECONDARY_LIMIT_BACKOFF_MS = 60_000;
const MAX_WAIT_MS = 300_000;

/**
 * Retry delay, or null if retrying won't help. Three shapes: explicit
 * `retry-after`, an exhausted primary budget (`x-ratelimit-remaining: 0` plus
 * a reset epoch), and a secondary-limit 403 with neither header.
 */
export function retryDelayMs(
  res: { status: number; headers: { get(name: string): string | null } },
  body: string,
  now: number = Date.now(),
): number | null {
  if (res.status !== 403 && res.status !== 429) return null;

  // `Number(null)` is 0 — distinguish absent from "retry immediately".
  const rawRetryAfter = res.headers.get("retry-after");
  const retryAfter = rawRetryAfter === null ? Number.NaN : Number(rawRetryAfter);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000 + 1000, MAX_WAIT_MS);
  }

  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (res.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000 - now, 0) + 1000, MAX_WAIT_MS);
  }

  if (/secondary rate limit/i.test(body)) return SECONDARY_LIMIT_BACKOFF_MS;
  return null; // an ordinary 403: bad token, missing scope, protected branch
}

/**
 * Tree entries have no base64 option, so anything not clean UTF-8 (or holding a
 * NUL) must go through `createBlob`. Valid UTF-8 round-trips byte-identically,
 * which keeps `gitBlobSha` idempotency intact.
 */
export function isInlineableText(content: FileContent): boolean {
  const bytes = toBytes(content);
  if (bytes.includes(0)) return false;
  if (typeof content === "string") return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export class GitHubRepo {
  private tokenPromise: Promise<string>;
  /** Timestamps of recent content-creating requests, for `gateWrite`. */
  private writeTimes: number[] = [];
  constructor(
    private readonly repo: string, // "owner/name"
    token: string | undefined,
  ) {
    this.tokenPromise = resolveToken(token);
  }

  /** Hold writes back so we never trip the 80/minute secondary limit. */
  private async gateWrite(): Promise<void> {
    for (;;) {
      const cutoff = Date.now() - 60_000;
      this.writeTimes = this.writeTimes.filter((t) => t > cutoff);
      if (this.writeTimes.length < WRITES_PER_MINUTE) break;
      await sleep(this.writeTimes[0]! - cutoff + 100);
    }
    this.writeTimes.push(Date.now());
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokenPromise;
    const isWrite = method !== "GET";

    for (let attempt = 0; ; attempt++) {
      if (isWrite) await this.gateWrite();

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
      if (res.ok) return (await res.json()) as T;

      const text = await res.text();
      const wait = retryDelayMs(res, text);
      if (wait === null || attempt >= MAX_RETRIES) {
        throw new HttpError(res.status, `${method} ${path} -> ${res.status}: ${text}`);
      }
      console.warn(
        `  ⏳ GitHub rate limit on ${method} ${path}; waiting ${Math.round(wait / 1000)}s ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES}).`,
      );
      await sleep(wait);
    }
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

  /** Chunked; each chunk builds on the tree the previous one produced. */
  async buildTree(baseTreeSha: string, entries: TreeEntryInput[]): Promise<string> {
    if (entries.length === 0) return baseTreeSha;
    const chunks = chunkTreeEntries(entries);
    if (chunks.length > 1) {
      console.log(`  Writing ${entries.length} tree entries in ${chunks.length} requests.`);
    }
    let sha = baseTreeSha;
    for (const chunk of chunks) sha = await this.createTree(sha, chunk);
    return sha;
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

export interface GitHubTargetOptions {
  repo: string; // "owner/name"
  branch: string;
  token?: string | undefined;
  authorName: string;
  authorEmail: string;
  /** Progress output. Defaults to console.log; pass a no-op to silence. */
  log?: (message: string) => void;
}

/**
 * A branch in a GitHub repo, written through the Git Data API as one atomic
 * commit per sync. The base is the target branch, or the repo's default branch
 * when it doesn't exist yet — so a first sync builds on real history.
 */
export class GitHubTarget implements SyncTarget {
  readonly label: string;
  private readonly gh: GitHubRepo;
  private readonly opts: GitHubTargetOptions;
  private readonly log: (message: string) => void;
  /** Resolved once by `readState`, and required by `readText`/`apply`. */
  private base:
    | { ref: string; head: string; treeSha: string; branchExists: boolean }
    | undefined;

  constructor(opts: GitHubTargetOptions) {
    this.opts = opts;
    this.gh = new GitHubRepo(opts.repo, opts.token);
    this.label = `${opts.repo}@${opts.branch}`;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  contentId(content: FileContent): string {
    return gitBlobSha(content);
  }

  async readState(): Promise<TargetState> {
    const branch = this.opts.branch;
    const branchHead = await this.gh.getBranchHead(branch);
    const branchExists = branchHead !== null;
    const defaultBranch = await this.gh.getDefaultBranch();
    const ref = branchExists ? branch : defaultBranch;
    const head = branchHead ?? (await this.gh.getBranchHead(defaultBranch));
    if (!head) throw new Error(`Could not resolve head commit for ${ref}.`);

    const treeSha = await this.gh.getCommitTreeSha(head);
    this.base = { ref, head, treeSha, branchExists };

    const treeFiles = await this.gh.getTreeFiles(treeSha);
    return {
      label: `${ref}@${head.slice(0, 7)}`,
      files: new Map([...treeFiles].map(([path, file]) => [path, file.sha])),
    };
  }

  async readText(path: string): Promise<string | null> {
    return await this.gh.getFileContent(path, this.requireBase().ref);
  }

  async apply(changes: TargetChanges, opts: ApplyOptions): Promise<ApplyResult> {
    const base = this.requireBase();

    // Text rides inline in the tree request — the whole reason a cold sync
    // fits inside GitHub's limits. One POST per file cannot fit in an hour.
    // Only binary files still need their own blob.
    const inline: Array<{ path: string; content: string }> = [];
    const binary: Array<{ path: string; content: FileContent }> = [];
    for (const f of changes.write) {
      if (isInlineableText(f.content)) {
        inline.push({ path: f.path, content: toBytes(f.content).toString("utf8") });
      } else {
        binary.push(f);
      }
    }
    if (binary.length) {
      this.log(`  Uploading ${binary.length} binary file(s) as blobs; ${inline.length} inline.`);
    }

    const uploaded: Array<{ path: string; sha: string }> = [];
    for (const f of binary) {
      uploaded.push({ path: f.path, sha: await this.gh.createBlob(f.content) });
    }

    const entries = toTreeEntries({ inline, uploaded, deletePaths: changes.delete });
    const newTreeSha = await this.gh.buildTree(base.treeSha, entries);
    if (newTreeSha === base.treeSha) return { changed: false };

    const commitSha = await this.gh.createCommit({
      message: opts.message,
      treeSha: newTreeSha,
      parents: [base.head],
      authorName: this.opts.authorName,
      authorEmail: this.opts.authorEmail,
    });

    if (base.branchExists) await this.gh.updateBranch(this.opts.branch, commitSha);
    else await this.gh.createBranch(this.opts.branch, commitSha);

    return {
      changed: true,
      revision: commitSha,
      url: this.gh.webBranchUrl(this.opts.branch),
    };
  }

  private requireBase() {
    if (!this.base) throw new Error("GitHubTarget: call readState() before reading or applying.");
    return this.base;
  }
}

/** `inline` entries cost no request of their own; `uploaded` are blobbed binaries. */
export function toTreeEntries(args: {
  inline: Array<{ path: string; content: string }>;
  uploaded: Array<{ path: string; sha: string }>;
  deletePaths: string[];
}): TreeEntryInput[] {
  const blob = { mode: "100644" as const, type: "blob" as const };
  return [
    ...args.inline.map((c) => ({ path: c.path, ...blob, content: c.content })),
    ...args.uploaded.map((c) => ({ path: c.path, ...blob, sha: c.sha })),
    ...args.deletePaths.map((p) => ({ path: p, ...blob, sha: null })),
  ];
}

// Split entries so no single request exceeds GitHub's tree limits. Deletions
// and sha references are tiny; inline content is what drives the byte budget.
export function chunkTreeEntries(
  entries: TreeEntryInput[],
  maxEntries = TREE_CHUNK_ENTRIES,
  maxBytes = TREE_CHUNK_BYTES,
): TreeEntryInput[][] {
  const chunks: TreeEntryInput[][] = [];
  let current: TreeEntryInput[] = [];
  let bytes = 0;
  for (const e of entries) {
    const size = "content" in e ? Buffer.byteLength(e.content, "utf8") : 0;
    // Never emit an empty chunk: a single oversized entry still has to go
    // somewhere, and GitHub rejecting it is more useful than us looping.
    if (current.length > 0 && (current.length >= maxEntries || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(e);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
