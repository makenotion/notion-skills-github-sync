import { createHash } from "node:crypto";

// Git's blob object id: sha1("blob " + byteLength + "\0" + content). Lets us
// detect unchanged files without uploading them, and gives true idempotency.
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  const h = createHash("sha1");
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest("hex");
}

export interface TreeChanges {
  create: Array<{ path: string; content: string }>;
  delete: string[];
  unchanged: number;
}

// Compare a desired file set against what's already in the branch tree.
// `existing` maps repo-relative path -> blob sha. `deletePaths` are paths we
// intend to remove (only those actually present are emitted).
export function computeChanges(opts: {
  existing: Map<string, string>;
  desired: Record<string, string>;
  deletePaths: string[];
}): TreeChanges {
  const create: Array<{ path: string; content: string }> = [];
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
