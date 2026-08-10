import { gunzipSync, unzipSync, zipSync } from "fflate";
import { untar } from "./untar.ts";

// Signed URL -> .tar.gz -> a flat map of dir-relative paths.
//
// The Skills API used to hand back one `.tar.gz` per *skill*. It now hands back
// one per *plugin*, laid out to the Agent Plugins 1.0 standard: a `plugin.json`
// at the root and every skill in an immediate subdirectory of `skills/`.
//
//   <plugin>.tar.gz          <- the ENVELOPE. Notion's transport for a plugin.
//     plugin.json            <- the Agent Plugins manifest (ignored here; this
//                               tool emits its own per-client manifests)
//     mcp.json               <- optional, per the standard
//     skills/
//       summarize/
//         SKILL.md           <- rendered server-side
//         my-files.zip       <- the PAYLOAD. What the author attached in Notion,
//                               usually a zip because they compressed a folder.
//
// `untar` opens the envelope; `unzipSkillArchive` opens an attachment inside a
// skill. The API archives an attached zip verbatim rather than expanding it, so
// we expand it here — otherwise a skill ships an opaque zip instead of files.

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

// Reject entry names that would escape the skill directory.
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

// Entries at the archive root. Used by setup; the inverse of the expansion below.
export function zipSkillFiles(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(entries);
}

// Zipping a *folder* (notably on Windows) wraps everything in one extra
// top-level dir — `my-skill/SKILL.md` instead of `SKILL.md` — which lands as a
// doubly-nested skill dir. Strip it when the sole top-level dir looks like a
// wrapper: it holds a SKILL.md, or its name matches the skill's slug. That
// guard stops a skill that legitimately ships one folder (`assets/`) from
// having its contents hoisted.
//
// `normalizeDirName` duplicates the shape of sync's `slugify` on purpose:
// `src/notion/` may not import from `src/sync/`.
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

// Directory entries, macOS cruft, and unsafe paths are dropped; a wrapping
// top-level dir is unwrapped. Passing the slug matters more than it looks:
// Notion renders SKILL.md server-side, so a user's zip often has none.
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

// The API wraps everything in a dir named after the page title. Drop it.
function stripCommonRoot(names: string[]): (name: string) => string {
  const first = names[0];
  if (!first) return (name) => name;
  const root = first.split("/")[0];
  if (!root || !names.every((n) => n === root || n.startsWith(`${root}/`))) {
    return (name) => name;
  }
  return (name) => (name === root ? name : name.slice(root.length + 1));
}

// Expand a lone attachment zip in place so nested folders survive. Anything
// else (no zip, several zips) is left exactly as delivered. The API-rendered
// SKILL.md is authoritative, so a zip entry can never shadow it.
function expandLoneZip(files: Record<string, Uint8Array>, skillSlug?: string): SkillFiles {
  const skipped: string[] = [];
  const zipNames = Object.keys(files).filter((n) => ZIP_RE.test(n) && !n.includes("/"));
  const zipName = zipNames.length === 1 ? zipNames[0]! : undefined;
  if (zipName) {
    const inner = unzipSkillArchive(files[zipName]!, skillSlug);
    delete files[zipName];
    skipped.push(...inner.skipped);
    for (const [path, content] of Object.entries(inner.files)) {
      if (path !== SKILL_MD) files[path] = content;
    }
  }
  return { files, skipped, expandedZip: zipName };
}

// A single skill's `.tar.gz` (the pre-plugins transport, and the shape of one
// skill's slice of a plugin archive): drop dir entries / cruft / unsafe paths,
// unwrap a single wrapping dir, then expand a lone attachment zip.
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

  const expanded = expandLoneZip(files, skillSlug);
  return { files: expanded.files, skipped: [...skipped, ...expanded.skipped], expandedZip: expanded.expandedZip };
}

const SKILLS_DIR_PREFIX = "skills/";

export interface PluginArchive {
  /** Immediate `skills/` subdirectory name -> that skill's assembled files. */
  skills: Record<string, SkillFiles>;
  /** Plugin-root files outside `skills/` (plugin.json, mcp.json, …). */
  extras: Record<string, Uint8Array>;
  /** Entry names dropped across the whole archive for being unsafe. */
  skipped: string[];
}

// A whole plugin's `.tar.gz`, in the Agent Plugins 1.0 layout. Bucket every
// entry under `skills/<dir>/` by that immediate subdirectory (deeper nesting is
// kept relative to it), and hand back anything else — `plugin.json`, `mcp.json`
// — as `extras`. Each skill bucket is assembled exactly as a standalone skill
// archive would be, so attachment-zip expansion behaves identically.
export function extractPluginArchive(targz: Uint8Array): PluginArchive {
  const entries = untar(gunzipSync(targz));
  const strip = stripCommonRoot(entries.map((e) => e.name));

  const skipped: string[] = [];
  const buckets: Record<string, Record<string, Uint8Array>> = {};
  const extras: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    const name = strip(entry.name).replace(/\\/g, "/");
    if (!name || IGNORED_ENTRY_RE.test(name)) continue;
    if (!isSafeEntryPath(name)) {
      skipped.push(entry.name);
      continue;
    }
    if (!name.startsWith(SKILLS_DIR_PREFIX)) {
      extras[name] = entry.data;
      continue;
    }
    const rest = name.slice(SKILLS_DIR_PREFIX.length);
    const slash = rest.indexOf("/");
    // A bare file directly under `skills/` isn't a skill (no SKILL.md dir).
    if (slash === -1) {
      extras[name] = entry.data;
      continue;
    }
    const dir = rest.slice(0, slash);
    (buckets[dir] ??= {})[rest.slice(slash + 1)] = entry.data;
  }

  const skills: Record<string, SkillFiles> = {};
  for (const [dir, files] of Object.entries(buckets)) {
    const assembled = expandLoneZip(files, dir);
    skipped.push(...assembled.skipped);
    skills[dir] = { files: assembled.files, skipped: assembled.skipped, expandedZip: assembled.expandedZip };
  }

  return { skills, extras, skipped };
}
