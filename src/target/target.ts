// Where a sync writes to — the load-bearing boundary. The engine computes a
// desired file set and hands it to a `SyncTarget`; everything above this line
// (layout, marketplace merging, pruning, the version_id fast path) is identical
// for all of them.
//
// A target defines what a *content id* means: an opaque string equal exactly
// when two files' bytes are equal. The engine only compares ids for equality.

import { createHash } from "node:crypto";

/** UTF-8 text (SKILL.md, manifests, markers) or raw bytes (zip attachments). */
export type FileContent = string | Uint8Array;

export function toBytes(content: FileContent): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

/**
 * sha1("blob " + byteLength + "\0" + content) — the default content id.
 * GitHub reports it for every file in a tree, so a target's whole state arrives
 * in one request and nothing has to be downloaded to know whether it changed.
 */
export function gitBlobSha(content: FileContent): string {
  const bytes = toBytes(content);
  const h = createHash("sha1");
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest("hex");
}

/** The target's current contents: every path, with its content id. */
export interface TargetState {
  /** For logs, e.g. `main@a1b2c3d`. */
  label: string;
  files: Map<string, string>;
}

export interface FileWrite {
  path: string;
  content: FileContent;
}

/** What one sync wants done. Paths are target-relative POSIX paths. */
export interface TargetChanges {
  write: FileWrite[];
  delete: string[];
  /** Desired files that already matched — reported, not written. */
  unchanged: number;
}

export interface ApplyOptions {
  message: string;
}

export interface ApplyResult {
  /** False when nothing actually needed writing. */
  changed: boolean;
  revision?: string;
  url?: string;
}

export interface SyncTarget {
  /** e.g. `owner/repo@main`. */
  readonly label: string;
  contentId(content: FileContent): string;
  readState(): Promise<TargetState>;
  /**
   * One file's text from the base state, or null. Needed because content ids
   * can't be un-hashed and the sync merges into files it doesn't fully own
   * (the client marketplace manifests).
   */
  readText(path: string): Promise<string | null>;
  /** Write and delete, atomically if the target can. */
  apply(changes: TargetChanges, opts: ApplyOptions): Promise<ApplyResult>;
}

/**
 * Diff a desired file set against the target's state. Only `deletePaths` that
 * are actually present are emitted, so a plan can name paths speculatively.
 */
export function computeChanges(opts: {
  existing: Map<string, string>;
  desired: Record<string, FileContent>;
  deletePaths: string[];
  contentId: (content: FileContent) => string;
}): TargetChanges {
  const write: FileWrite[] = [];
  let unchanged = 0;

  for (const [path, content] of Object.entries(opts.desired)) {
    if (opts.existing.get(path) === opts.contentId(content)) unchanged++;
    else write.push({ path, content });
  }

  const del = opts.deletePaths.filter((p) => opts.existing.has(p));
  return { write, delete: del, unchanged };
}

export function hasChanges(changes: TargetChanges): boolean {
  return changes.write.length > 0 || changes.delete.length > 0;
}
