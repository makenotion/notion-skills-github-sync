import { createHash } from "node:crypto";

// File content flowing through the pipeline is either UTF-8 text (the common
// case: SKILL.md, plugin.json, markers) or raw bytes (files unpacked from a
// skill's zip attachment, which may be binary).
export type FileContent = string | Uint8Array;

// Normalize any FileContent to a Buffer of its on-disk bytes.
export function toBytes(content: FileContent): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

// Git's blob object id: sha1("blob " + byteLength + "\0" + content). Lets us
// detect unchanged files without uploading them, and gives true idempotency.
// Works for both text and binary content.
export function gitBlobSha(content: FileContent): string {
  const bytes = toBytes(content);
  const h = createHash("sha1");
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest("hex");
}

export interface TreeChanges {
  create: Array<{ path: string; content: FileContent }>;
  delete: string[];
  unchanged: number;
}

// Compare a desired file set against what's already in the branch tree.
// `existing` maps repo-relative path -> blob sha. `deletePaths` are paths we
// intend to remove (only those actually present are emitted).
export function computeChanges(opts: {
  existing: Map<string, string>;
  desired: Record<string, FileContent>;
  deletePaths: string[];
}): TreeChanges {
  const create: Array<{ path: string; content: FileContent }> = [];
  let unchanged = 0;

  for (const [path, content] of Object.entries(opts.desired)) {
    if (opts.existing.get(path) === gitBlobSha(content)) unchanged++;
    else create.push({ path, content });
  }

  const del = opts.deletePaths.filter((p) => opts.existing.has(p));
  return { create, delete: del, unchanged };
}

export function hasChanges(changes: TreeChanges): boolean {
  return changes.create.length > 0 || changes.delete.length > 0;
}
