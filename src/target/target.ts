// Where a sync writes to.
//
// This is the load-bearing boundary of the tool. The engine never writes files
// itself; it computes a desired file set and hands it to a `SyncTarget`. A
// GitHub target commits it, a filesystem target would write it to disk, and the
// in-memory target records it for tests. Everything above this line — plugin
// layout, marketplace merging, pruning, the `version_id` fast path — is
// identical for all of them.
//
// The one thing a target must define is what a *content id* means: an opaque
// string that is equal exactly when two files' bytes are equal. GitHub's answer
// is the git blob sha, which is why `gitBlobSha` lives here and is the default
// every implementation uses. The engine only ever compares ids for equality, so
// a target is free to use any hash it likes.

import { createHash } from "node:crypto";

/**
 * File content flowing through the pipeline: UTF-8 text (the common case —
 * SKILL.md, plugin.json, markers) or raw bytes (files unpacked from a skill's
 * zip attachment, which may be binary).
 */
export type FileContent = string | Uint8Array;

/** Normalize any FileContent to a Buffer of its on-disk bytes. */
export function toBytes(content: FileContent): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

/**
 * Git's blob object id: sha1("blob " + byteLength + "\0" + content).
 *
 * The default content id. It's what GitHub already reports for every file in a
 * tree, so using it means a target's whole state arrives in one request and no
 * file has to be downloaded to know whether it changed.
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
  /** Human label for the base state, for logs (e.g. `main@a1b2c3d`). */
  label: string;
  /** Target-relative POSIX path -> content id. */
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
  /** Commit message, or the equivalent description of the change. */
  message: string;
}

export interface ApplyResult {
  /** False when the target decided nothing actually needed writing. */
  changed: boolean;
  /** Commit sha, or whatever revision id the target produced. */
  revision?: string;
  /** Where a human can go look at the result. */
  url?: string;
}

export interface SyncTarget {
  /** Human label for the destination, e.g. `owner/repo@main`. */
  readonly label: string;
  /** Content id for a file's bytes; equal ids mean equal content. */
  contentId(content: FileContent): string;
  /** Every path currently in the target, with its content id. */
  readState(): Promise<TargetState>;
  /**
   * Read one file's text from the base state, or null if absent.
   *
   * Needed because content ids alone can't be un-hashed, and the sync has to
   * *merge into* files it doesn't fully own (the client marketplace manifests).
   */
  readText(path: string): Promise<string | null>;
  /** Write and delete, atomically if the target can. */
  apply(changes: TargetChanges, opts: ApplyOptions): Promise<ApplyResult>;
}

/**
 * Compare a desired file set against the target's current state.
 *
 * `deletePaths` are paths the caller intends to remove; only those actually
 * present are emitted, so a plan can name paths speculatively.
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
