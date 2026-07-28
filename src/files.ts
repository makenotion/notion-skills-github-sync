import { unzipSync, zipSync } from "fflate";
import { gunzipSync } from "fflate";
import { untar } from "./untar.ts";

// Skill file handling.
//
// A skill directory arrives from the Notion skills API as one .tar.gz holding
// `<Page Title>/SKILL.md` plus the page's Files-property attachments, flattened
// alongside it. We strip that wrapper directory and lay the rest straight into
// the skill dir in the repo.
//
// One Notion-side convention survives the move: attachments are stored as a
// single .zip when a skill needs real structure (a `scripts/` dir, an
// `assets/` dir). The API archives that zip verbatim rather than expanding it,
// so we expand it here — otherwise a plugin would ship an opaque zip instead of
// usable files.

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
const ZIP_RE = /\.zip$/i;

export interface ExtractResult {
  /** Skill-dir-relative POSIX path -> bytes. Includes the rendered SKILL.md. */
  files: Record<string, Uint8Array>;
  /** Entry names dropped for being unsafe (traversal / absolute paths). */
  skipped: string[];
  /** Name of the attachment zip that was expanded in place, if any. */
  expandedZip?: string;
}

// Build a zip archive from a map of POSIX-relative path -> content, with the
// entries at the archive root. Used by the setup wizard to attach sample files
// to a skill page (the inverse of the in-place expansion below).
export function zipSkillFiles(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(entries);
}

// Unpack a zip archive into a map of POSIX-relative path -> bytes. Directory
// entries, macOS cruft (__MACOSX, .DS_Store), and unsafe paths are dropped.
export function unzipSkillArchive(bytes: Uint8Array): { files: Record<string, Uint8Array>; skipped: string[] } {
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
  return { files, skipped };
}

// If every entry sits under the same first path segment, that's the archive's
// wrapper directory (the API names it after the page title) and we drop it.
function stripCommonRoot(names: string[]): (name: string) => string {
  const first = names[0];
  if (!first) return (name) => name;
  const root = first.split("/")[0];
  if (!root || !names.every((n) => n === root || n.startsWith(`${root}/`))) {
    return (name) => name;
  }
  return (name) => (name === root ? name : name.slice(root.length + 1));
}

/**
 * Turn a skill directory .tar.gz from the Notion skills API into the files that
 * belong in the repo's skill directory.
 */
export function extractSkillArchive(targz: Uint8Array): ExtractResult {
  const entries = untar(gunzipSync(targz));
  const strip = stripCommonRoot(entries.map((e) => e.name));

  const files: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  for (const entry of entries) {
    const name = strip(entry.name).replace(/\\/g, "/");
    if (!name || IGNORED_ENTRY_RE.test(name)) continue;
    if (!isSafeEntryPath(name)) {
      skipped.push(entry.name);
      continue;
    }
    files[name] = entry.data;
  }

  // Expand a lone attachment zip in place so nested folders survive the round
  // trip. Anything else (no zip, several zips) is left exactly as delivered.
  const zipNames = Object.keys(files).filter((n) => ZIP_RE.test(n) && !n.includes("/"));
  const zipName = zipNames.length === 1 ? zipNames[0]! : undefined;
  if (zipName) {
    const inner = unzipSkillArchive(files[zipName]!);
    delete files[zipName];
    skipped.push(...inner.skipped);
    // The API-rendered SKILL.md is authoritative; a zip can't shadow it.
    for (const [path, content] of Object.entries(inner.files)) {
      if (path !== SKILL_MD) files[path] = content;
    }
  }

  return { files, skipped, expandedZip: zipName };
}

export const SKILL_MD = "SKILL.md";
