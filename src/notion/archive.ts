import { gunzipSync, unzipSync, zipSync } from "fflate";
import { untar } from "./untar.ts";

// Skill archive handling: signed URL -> .tar.gz -> a flat map of files.
//
// A skill directory arrives from the Skills API as one .tar.gz holding
// `<Page Title>/SKILL.md` plus the page's Files-property attachments, flattened
// alongside it. We strip that wrapper directory and hand back the rest keyed by
// skill-dir-relative POSIX path.
//
// One Notion-side convention survives the move: attachments are stored as a
// single .zip when a skill needs real structure (a `scripts/` dir, an `assets/`
// dir). The API archives that zip verbatim rather than expanding it, so we
// expand it here — otherwise a plugin would ship an opaque zip instead of usable
// files.

/** Download a (signed) URL to bytes, using the caller's `fetch`. */
export async function downloadArchive(
  url: string,
  fetchImpl: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Failed to download skill archive (${res.status} ${res.statusText}): ${url}`);
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

export const SKILL_MD = "SKILL.md";

export interface SkillFiles {
  /** Skill-dir-relative POSIX path -> bytes. Includes the rendered SKILL.md. */
  files: Record<string, Uint8Array>;
  /** Entry names dropped for being unsafe (traversal / absolute paths). */
  skipped: string[];
  /** Name of the attachment zip that was expanded in place, if any. */
  expandedZip?: string;
}

// Build a zip archive from a map of POSIX-relative path -> content, with the
// entries at the archive root. Used by setup to attach sample files to a skill
// page (the inverse of the in-place expansion below).
export function zipSkillFiles(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(entries);
}

// Some archivers — notably zipping a *folder* on Windows — wrap the skill's
// contents in one extra top-level directory:
//   my-skill/SKILL.md, my-skill/scripts/run.py
// instead of the expected root layout:
//   SKILL.md, scripts/run.py
// Laid down as-is that produces a doubly-nested skill dir, which breaks the
// skill. When every entry shares one top-level directory (nothing at the root)
// AND that directory looks like a wrapped skill folder, strip the prefix.
//
// "Looks like a wrapped skill folder" means it holds a SKILL.md directly, or
// its name matches the skill's slug. That guard keeps a skill that legitimately
// ships a single folder (just `assets/`, say) from having its contents wrongly
// hoisted to the skill root.
//
// `normalizeDirName` deliberately duplicates the shape of sync's `slugify`
// rather than importing it: `src/notion/` stays importable on its own, so it
// may not depend on `src/sync/`.
const SKILL_MD_RE = /^[^/]+\/SKILL\.md$/i;

const normalizeDirName = (dir: string): string =>
  dir
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function stripSingleTopLevelDir(
  files: Record<string, Uint8Array>,
  skillSlug?: string,
): Record<string, Uint8Array> {
  const paths = Object.keys(files);
  if (paths.length === 0) return files;

  const topLevels = new Set<string>();
  for (const p of paths) {
    const slash = p.indexOf("/");
    // An entry with no "/" lives at the root — there's no single wrapping dir.
    if (slash === -1) return files;
    topLevels.add(p.slice(0, slash));
  }
  if (topLevels.size !== 1) return files;

  const dir = [...topLevels][0]!;
  const looksWrapped =
    paths.some((p) => SKILL_MD_RE.test(p)) ||
    (skillSlug !== undefined && normalizeDirName(dir) === normalizeDirName(skillSlug));
  if (!looksWrapped) return files;

  const prefix = `${dir}/`;
  const unwrapped: Record<string, Uint8Array> = {};
  for (const [p, content] of Object.entries(files)) {
    unwrapped[p.slice(prefix.length)] = content;
  }
  return unwrapped;
}

// Unpack a zip archive into a map of POSIX-relative path -> bytes. Directory
// entries, macOS cruft (__MACOSX, .DS_Store), and unsafe paths are dropped. A
// single wrapping top-level directory is unwrapped — see
// `stripSingleTopLevelDir`. Passing the skill's slug lets a wrapper named after
// the skill be unwrapped even when it ships no SKILL.md, which is the common
// case now that Notion renders SKILL.md server-side.
export function unzipSkillArchive(
  bytes: Uint8Array,
  skillSlug?: string,
): {
  files: Record<string, Uint8Array>;
  skipped: string[];
} {
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
 * Turn a skill directory .tar.gz from the Skills API into the files that belong
 * in the skill's directory.
 */
export function extractSkillArchive(targz: Uint8Array, skillSlug?: string): SkillFiles {
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
    const inner = unzipSkillArchive(files[zipName]!, skillSlug);
    delete files[zipName];
    skipped.push(...inner.skipped);
    // The API-rendered SKILL.md is authoritative; a zip can't shadow it.
    for (const [path, content] of Object.entries(inner.files)) {
      if (path !== SKILL_MD) files[path] = content;
    }
  }

  return { files, skipped, expandedZip: zipName };
}
