import { unzipSync, zipSync } from "fflate";
import type { NotionFileRef } from "./notion/types.ts";
import { slugify } from "./slugify.ts";

// How the sync treats a skill's "Files" property: it's either empty, or it
// holds exactly one zip archive whose contents are laid down inside the skill
// directory. Both are valid, unremarkable states. Anything that doesn't match
// that shape (no zip among some loose files, more than one zip) just doesn't
// resolve to a zip to unpack — there's no misconfiguration to flag, since the
// property may simply be holding something unrelated.

const ZIP_RE = /\.zip$/i;

// Pick the single zip to unpack from a Files property, or null if it doesn't
// hold exactly one .zip (including the ordinary case of no files at all).
export function pickSkillZip(files: NotionFileRef[] | undefined): NotionFileRef | null {
  const zips = (files ?? []).filter((f) => ZIP_RE.test(f.name));
  return zips.length === 1 ? zips[0]! : null;
}

// Download a (signed) file URL to bytes.
export async function downloadFile(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download file (${res.status} ${res.statusText}): ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Reject archive entry names that would escape the skill directory or are
// otherwise unsafe to write to disk (absolute paths, parent traversal). Also
// normalizes Windows separators to POSIX.
export function isSafeEntryPath(name: string): boolean {
  if (!name) return false;
  const norm = name.replace(/\\/g, "/");
  if (norm.startsWith("/")) return false;
  if (/(^|\/)\.\.(\/|$)/.test(norm)) return false;
  return true;
}

const IGNORED_ENTRY_RE = /(^|\/)(__MACOSX\/|\.DS_Store$)/;

export interface UnzipResult {
  files: Record<string, Uint8Array>;
  skipped: string[];
}

// Some archivers (notably zipping a *folder* on Windows) wrap the skill's
// contents in a single extra top-level directory, e.g.
//   my-skill/SKILL.md, my-skill/scripts/run.py
// instead of the expected root layout
//   SKILL.md, scripts/run.py
// Left as-is this produces a doubly-nested plugin dir in GitHub and breaks the
// skill. When every file shares one common top-level directory (and nothing
// sits at the root) AND that directory looks like a wrapped skill folder, strip
// the prefix so the contents land at the skill root.
//
// "Looks like a wrapped skill folder" means either the directory holds a
// SKILL.md directly (the file that defines a skill) or its name matches the
// skill's slug. That guard keeps us from unwrapping a skill that legitimately
// ships a single folder (e.g. just `assets/` or `references/`), which would
// otherwise wrongly hoist that folder's contents to the skill root.
//
// ZIPs already laid out at the root are returned unchanged.
const SKILL_MD_RE = /^[^/]+\/SKILL\.md$/i;

export function stripSingleTopLevelDir(
  files: Record<string, Uint8Array>,
  skillSlug?: string,
): Record<string, Uint8Array> {
  const paths = Object.keys(files);
  if (paths.length === 0) return files;

  const topLevels = new Set<string>();
  for (const p of paths) {
    const slash = p.indexOf("/");
    // A file with no "/" lives at the root — there's no single wrapping dir.
    if (slash === -1) return files;
    topLevels.add(p.slice(0, slash));
  }
  if (topLevels.size !== 1) return files;

  const dir = [...topLevels][0]!;
  const looksWrapped =
    paths.some((p) => SKILL_MD_RE.test(p)) ||
    (skillSlug !== undefined && slugify(dir) === skillSlug);
  if (!looksWrapped) return files;

  const prefix = `${dir}/`;
  const unwrapped: Record<string, Uint8Array> = {};
  for (const [p, content] of Object.entries(files)) {
    unwrapped[p.slice(prefix.length)] = content;
  }
  return unwrapped;
}

// Build a zip archive from a map of POSIX-relative path -> content, with the
// entries at the archive root (the layout `unzipSkillArchive` expects). Used
// by the setup wizard to attach sample files to a skill page.
export function zipSkillFiles(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(entries);
}

// Unpack a zip archive into a map of POSIX-relative path -> bytes. Directory
// entries, macOS cruft (__MACOSX, .DS_Store), and unsafe paths are dropped. A
// single wrapping top-level directory (a common result of zipping a skill
// folder on Windows) is unwrapped — see `stripSingleTopLevelDir`. Passing the
// skill's slug lets a wrapper named after the skill be unwrapped even when it
// ships no SKILL.md.
export function unzipSkillArchive(bytes: Uint8Array, skillSlug?: string): UnzipResult {
  const raw = unzipSync(bytes);
  const files: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  for (const [name, content] of Object.entries(raw)) {
    if (name.endsWith("/")) continue; // directory entry
    if (IGNORED_ENTRY_RE.test(name)) continue;
    if (!isSafeEntryPath(name)) {
      skipped.push(name);
      continue;
    }
    files[name.replace(/\\/g, "/")] = content;
  }
  return { files: stripSingleTopLevelDir(files, skillSlug), skipped };
}
