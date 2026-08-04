// An in-memory `SyncTarget`.
//
// This is what makes a whole sync runnable with no network on the write side:
// the engine can't tell it apart from the GitHub target, so tests assert on the
// thing that actually matters — the resulting file tree, what got deleted, and
// how many commits it took — rather than on which API calls were made.
//
// It also doubles as the readable reference implementation of the interface: if
// you want to publish skills somewhere else (a filesystem, an S3 bucket, another
// forge), this file is the shape to copy.

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

/** One recorded `apply` — the equivalent of a commit. */
export interface MemoryCommit {
  message: string;
  written: string[];
  deleted: string[];
}

export class MemoryTarget implements SyncTarget {
  readonly label: string;
  /** Current contents, path -> bytes. */
  readonly files = new Map<string, Uint8Array>();
  /** Every applied change set, oldest first. */
  readonly commits: MemoryCommit[] = [];
  private revision = 0;

  constructor(initial: Record<string, FileContent> = {}, label = "memory") {
    this.label = label;
    for (const [path, content] of Object.entries(initial)) this.write(path, content);
  }

  contentId(content: FileContent): string {
    return gitBlobSha(content);
  }

  async readState(): Promise<TargetState> {
    const files = new Map<string, string>();
    for (const [path, bytes] of this.files) files.set(path, gitBlobSha(bytes));
    return { label: `${this.label}@${this.revision}`, files };
  }

  async readText(path: string): Promise<string | null> {
    const bytes = this.files.get(path);
    return bytes === undefined ? null : new TextDecoder().decode(bytes);
  }

  async apply(changes: TargetChanges, opts: ApplyOptions): Promise<ApplyResult> {
    for (const f of changes.write) this.write(f.path, f.content);
    for (const path of changes.delete) this.files.delete(path);
    this.revision++;
    this.commits.push({
      message: opts.message,
      written: changes.write.map((f) => f.path),
      deleted: [...changes.delete],
    });
    return { changed: true, revision: String(this.revision) };
  }

  // --- Test conveniences ----------------------------------------------------

  /** Every path currently present, sorted. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Paths under a prefix, sorted. */
  pathsUnder(prefix: string): string[] {
    return this.paths().filter((p) => p.startsWith(prefix));
  }

  /** A file's content as text. Throws if it isn't there — a missing file is a
   *  test failure, not a null to thread through assertions. */
  text(path: string): string {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`MemoryTarget: no such file "${path}"`);
    return new TextDecoder().decode(bytes);
  }

  /** A file's raw bytes. */
  bytes(path: string): Uint8Array {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`MemoryTarget: no such file "${path}"`);
    return bytes;
  }

  json<T = unknown>(path: string): T {
    return JSON.parse(this.text(path)) as T;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  private write(path: string, content: FileContent): void {
    this.files.set(path, new Uint8Array(toBytes(content)));
  }
}
