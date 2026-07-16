import { unzipSync } from "fflate";
import type { NotionFileRef } from "./notion/types.ts";

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

// Unpack a zip archive into a map of POSIX-relative path -> bytes. Directory
// entries, macOS cruft (__MACOSX, .DS_Store), and unsafe paths are dropped.
export function unzipSkillArchive(bytes: Uint8Array): UnzipResult {
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
