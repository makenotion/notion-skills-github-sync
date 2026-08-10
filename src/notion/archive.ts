import { gunzipSync, unzipSync, zipSync } from "fflate";
import { untar } from "./untar.ts";

// Signed URL -> .tar.gz -> an opaque Agent Plugin directory.
//
// The Plugins API hands back one `.tar.gz` per *plugin*, laid out to the Agent
// Plugins 1.0 standard: everything under one wrapping directory named after the
// plugin, a `plugin.json` at its root, and every skill in an immediate
// subdirectory of `skills/`.
//
//   <plugin>.tar.gz          <- the ENVELOPE. Notion's transport for a plugin.
//     my-plugin/             <- one wrapping dir, stripped on the way in
//       plugin.json          <- the Agent Plugins manifest (preserved)
//       mcp.json             <- optional, per the standard
//       skills/
//         summarize/
//           SKILL.md         <- rendered server-side
//           my-files.zip     <- the PAYLOAD. What the author attached in Notion,
//                               usually a zip because they compressed a folder.
//
// After stripping the transport's wrapping directory, every plugin file maps
// 1:1 onto the published directory. The only content-aware behavior is expanding
// a skill's lone attached zip: the API currently archives those verbatim.

/** Download a (signed) URL to bytes, using the caller's `fetch`. */
export async function downloadArchive(
  url: string,
  fetchImpl: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Failed to download plugin archive (${res.status} ${res.statusText}): ${url}`);
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
const SKILLS_DIR_PREFIX = "skills/";

/** One skill's assembled files, mid-extraction. */
interface SkillFiles {
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

// The API wraps everything in a dir named after the plugin. Drop it.
//
// `skills` is never that wrapper: the standard puts `skills/` *at* the plugin
// root, so an archive holding nothing but skills would otherwise look like one
// wrapped directory and get hoisted out of the layout entirely.
function stripCommonRoot(names: string[]): (name: string) => string {
  const first = names[0];
  if (!first) return (name) => name;
  const root = first.split("/")[0];
  if (
    !root ||
    `${root}/` === SKILLS_DIR_PREFIX ||
    !names.every((n) => n === root || n.startsWith(`${root}/`))
  ) {
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

export interface PluginFiles {
  /** Plugin-dir-relative POSIX path -> bytes. */
  files: Record<string, Uint8Array>;
  /** Unsafe entry names dropped while expanding user-provided zip attachments. */
  skipped: string[];
  /** Attachment zips expanded in place, as `<skill>/<zip>`. */
  expandedZips: string[];
}

/**
 * A whole plugin's `.tar.gz` -> its directory, with only skill attachment zips
 * expanded. The API owns the plugin's structure and validity; this reader does
 * not filter root files, discover skills, or require particular files.
 */
export function extractPluginArchive(targz: Uint8Array): PluginFiles {
  const entries = untar(gunzipSync(targz));
  const strip = stripCommonRoot(entries.map((e) => e.name));

  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    const name = strip(entry.name).replace(/\\/g, "/");
    if (name) files[name] = entry.data;
  }

  const skipped: string[] = [];
  const expandedZips: string[] = [];
  const skillDirs = new Set<string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(SKILLS_DIR_PREFIX)) continue;
    const rest = path.slice(SKILLS_DIR_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash > 0) skillDirs.add(rest.slice(0, slash));
  }

  for (const dir of skillDirs) {
    const prefix = `${SKILLS_DIR_PREFIX}${dir}/`;
    const bucket: Record<string, Uint8Array> = {};
    for (const [path, data] of Object.entries(files)) {
      if (path.startsWith(prefix)) bucket[path.slice(prefix.length)] = data;
    }
    const assembled = expandLoneZip(bucket, dir);
    skipped.push(...assembled.skipped);
    if (assembled.expandedZip) {
      expandedZips.push(`${dir}/${assembled.expandedZip}`);
      for (const path of Object.keys(files)) {
        if (path.startsWith(prefix)) delete files[path];
      }
      for (const [rel, data] of Object.entries(assembled.files)) files[`${prefix}${rel}`] = data;
    }
  }

  return { files, skipped, expandedZips };
}
