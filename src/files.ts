import { unzipSync } from "fflate";
import type { NotionFileRef } from "./notion/types.ts";

// How the sync treats a skill's "Files" property: we support (optionally) a
// single zip archive whose contents are laid down inside the skill directory.
// Anything else (loose files, multiple zips) is ignored with a warning — this
// is deliberately a minimal "one zip = the skill's extra files" contract.

const ZIP_RE = /\.zip$/i;

export interface PickZipResult {
  zip: NotionFileRef | null;
  warning?: string;
}

// Choose the single zip to unpack from a Files property. Returns a warning
// string (for the caller to log) when the property is present but unusable.
export function pickSkillZip(files: NotionFileRef[] | undefined): PickZipResult {
  const list = files ?? [];
  if (list.length === 0) return { zip: null };

  const zips = list.filter((f) => ZIP_RE.test(f.name));
  const nonZips = list.filter((f) => !ZIP_RE.test(f.name));

  if (zips.length === 0) {
    return {
      zip: null,
      warning:
        `Files property has ${list.length} file(s) but no .zip — ignoring. ` +
        `Attach a single .zip whose contents are the skill's extra files.`,
    };
  }
  if (zips.length > 1) {
    return {
      zip: null,
      warning:
        `Files property has ${zips.length} .zip files — ignoring all. ` +
        `Attach exactly one .zip per skill.`,
    };
  }
  const zip = zips[0]!;
  if (nonZips.length > 0) {
    return {
      zip,
      warning:
        `Files property has ${nonZips.length} non-zip file(s) alongside ${zip.name} — ` +
        `only the zip is unpacked; the others are ignored.`,
    };
  }
  return { zip };
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
