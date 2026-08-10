import { gunzipSync, unzipSync, zipSync } from "fflate";
import { untar } from "./untar.ts";

// Signed URL -> .tar.gz -> the files a plugin directory should contain.
//
// The Plugins API hands back one `.tar.gz` per *plugin*, laid out to the Agent
// Plugins 1.0 standard: everything under one wrapping directory named after the
// plugin, a `plugin.json` at its root, and every skill in an immediate
// subdirectory of `skills/`.
//
//   <plugin>.tar.gz          <- the ENVELOPE. Notion's transport for a plugin.
//     my-plugin/             <- one wrapping dir, stripped on the way in
//       plugin.json          <- the Agent Plugins manifest (ignored: this tool
//                               emits its own per-client manifests)
//       mcp.json             <- optional, per the standard
//       skills/
//         summarize/
//           SKILL.md         <- rendered server-side
//           my-files.zip     <- the PAYLOAD. What the author attached in Notion,
//                               usually a zip because they compressed a folder.
//
// The `skills/` subtree maps 1:1 onto the published plugin directory, which is
// why extraction returns plugin-dir-relative paths and the sync writes them
// through untouched. `untar` opens the envelope; `unzipSkillArchive` opens an
// attachment inside a skill. The API archives an attached zip verbatim rather
// than expanding it, so we expand it here — otherwise a skill would ship an
// opaque zip instead of files.

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
  /**
   * Plugin-dir-relative POSIX path -> bytes, always under `skills/<dir>/`.
   * Written through to the published plugin directory verbatim.
   */
  files: Record<string, Uint8Array>;
  /** The `skills/<dir>/` names present, sorted. Every one has a SKILL.md. */
  skills: string[];
  /** Entry names dropped for being unsafe (traversal / absolute paths). */
  skipped: string[];
  /** Attachment zips expanded in place, as `<skill>/<zip>`. */
  expandedZips: string[];
  /** Entries dropped for not being part of a skill (plugin.json, mcp.json, …). */
  ignored: string[];
  /** `skills/<dir>/` names dropped for having no SKILL.md. */
  invalid: string[];
}

/**
 * A whole plugin's `.tar.gz` -> the files its published directory should hold.
 *
 * Entries are bucketed by their immediate `skills/` subdirectory so a lone
 * attachment zip expands within its own skill, then flattened back to
 * `skills/<dir>/...` paths. Anything outside `skills/` is dropped: the Agent
 * Plugins `plugin.json` at the archive root would collide with the per-client
 * manifests this tool generates (and can disagree with them about the plugin's
 * name once a slug is deduplicated).
 *
 * A skill directory with no SKILL.md is not a skill, so it's dropped whole
 * rather than published as a fragment. That also keeps `skills` equal to the set
 * of directories a synced repo will contain, which is what makes the marker's
 * skill list a reliable heal trigger.
 */
export function extractPluginArchive(targz: Uint8Array): PluginFiles {
  const entries = untar(gunzipSync(targz));
  const strip = stripCommonRoot(entries.map((e) => e.name));

  const skipped: string[] = [];
  const ignored: string[] = [];
  const buckets = new Map<string, Record<string, Uint8Array>>();
  for (const entry of entries) {
    const name = strip(entry.name).replace(/\\/g, "/");
    if (!name || IGNORED_ENTRY_RE.test(name)) continue;
    if (!isSafeEntryPath(name)) {
      skipped.push(entry.name);
      continue;
    }
    const rest = name.startsWith(SKILLS_DIR_PREFIX)
      ? name.slice(SKILLS_DIR_PREFIX.length)
      : undefined;
    const slash = rest?.indexOf("/") ?? -1;
    // Outside `skills/`, or a bare file directly under it: not part of a skill.
    if (rest === undefined || slash === -1) {
      ignored.push(name);
      continue;
    }
    const dir = rest.slice(0, slash);
    const bucket = buckets.get(dir) ?? {};
    bucket[rest.slice(slash + 1)] = entry.data;
    buckets.set(dir, bucket);
  }

  const files: Record<string, Uint8Array> = {};
  const skills: string[] = [];
  const expandedZips: string[] = [];
  const invalid: string[] = [];
  // Plain code-unit sort, matching how the sync sorts the repo's own skill dirs.
  // These two orderings feed the same marker field, so they must agree exactly —
  // and `localeCompare` can't be trusted to, since it varies with the runtime's
  // ICU data. A mismatch would rewrite every plugin on every run, forever.
  for (const [dir, bucket] of [...buckets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const assembled = expandLoneZip(bucket, dir);
    skipped.push(...assembled.skipped);
    if (!assembled.files[SKILL_MD]) {
      invalid.push(dir);
      continue;
    }
    skills.push(dir);
    if (assembled.expandedZip) expandedZips.push(`${dir}/${assembled.expandedZip}`);
    for (const [rel, data] of Object.entries(assembled.files)) {
      files[`${SKILLS_DIR_PREFIX}${dir}/${rel}`] = data;
    }
  }

  return { files, skills, skipped, expandedZips, ignored, invalid };
}
