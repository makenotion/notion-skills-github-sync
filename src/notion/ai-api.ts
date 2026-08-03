// Client for the Notion "AI plugins/skills" API.
//
//   GET /v1/ai/plugins            — plugins exposed by the connected workspace.
//                                   Each plugin groups one or more skill
//                                   directories. Standard Notion list
//                                   pagination (page_size / start_cursor /
//                                   has_more / next_cursor).
//   GET /v1/ai/skills/:id         — a signed S3 link to a compressed skill
//                                   directory (+ a content-hash version id).
//
// This API does the grouping-by-plugin and packaging-into-zips that the sync
// script used to compute from the raw Notion pages, so it's the ONE place the
// response shape lives. The raw JSON is parsed defensively (tolerating
// snake_case / camelCase and a couple of plausible field aliases) and
// normalized into the small shapes below, so a schema tweak stays contained
// here.

import { ntnApi } from "./ntn.ts";

/** A skill directory belonging to a plugin, addressable via GET /v1/ai/skills/:id. */
export interface AiSkillDirectoryRef {
  /** UUID passed to GET /v1/ai/skills/:id. */
  id: string;
  /** Directory name to place under the plugin's `skills/` dir. */
  name: string;
}

/** A plugin: the installation + synchronization unit, grouping skill directories. */
export interface AiPlugin {
  /** Plugin slug / directory name under the plugins dir. */
  name: string;
  /** Human description (may be empty). */
  description: string;
  skillDirectories: AiSkillDirectoryRef[];
}

/** The download descriptor for one skill directory (GET /v1/ai/skills/:id). */
export interface AiSkillArchive {
  id: string;
  /** Signed S3 link to the compressed skill directory (valid ~1 hour). */
  url: string;
  /** Content hash of the skill directory (stable across identical content). */
  versionId: string;
}

export interface AiPluginsApi {
  listPlugins(): Promise<AiPlugin[]>;
  getSkillArchive(id: string): Promise<AiSkillArchive>;
}

// --- Defensive parsing -------------------------------------------------------

function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return "";
}

export function parsePlugin(raw: any): AiPlugin {
  const name = firstString(raw?.name, raw?.slug, raw?.id);
  const description = firstString(raw?.description);
  const dirsRaw =
    raw?.skillDirectories ?? raw?.skill_directories ?? raw?.skills ?? raw?.directories ?? [];
  const skillDirectories: AiSkillDirectoryRef[] = (Array.isArray(dirsRaw) ? dirsRaw : [])
    .map((d: any): AiSkillDirectoryRef => {
      if (typeof d === "string") return { id: d, name: d };
      const id = firstString(d?.id, d?.skill_id, d?.skillId, d?.skill_directory_id);
      const name = firstString(d?.name, d?.directory, d?.path, d?.slug, id);
      return { id, name };
    })
    .filter((d) => d.id.length > 0);
  return { name, description, skillDirectories };
}

export function parseArchive(raw: any): AiSkillArchive {
  return {
    id: firstString(raw?.id),
    url: firstString(raw?.url, raw?.signed_url, raw?.download_url),
    versionId: firstString(raw?.version_id, raw?.versionId, raw?.version, raw?.content_hash),
  };
}

interface ListResponse {
  results?: unknown[];
  plugins?: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** AiPluginsApi backed by the `ntn` CLI (same transport as the rest of the sync). */
export class NtnAiPluginsApi implements AiPluginsApi {
  constructor(private readonly env: string) {}

  async listPlugins(): Promise<AiPlugin[]> {
    const plugins: AiPlugin[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ page_size: "100" });
      if (cursor) q.set("start_cursor", cursor);
      const res = await ntnApi<ListResponse>(this.env, "GET", `/v1/ai/plugins?${q.toString()}`);
      const results = Array.isArray(res?.results)
        ? res.results
        : Array.isArray(res?.plugins)
          ? res.plugins
          : [];
      for (const r of results) plugins.push(parsePlugin(r));
      cursor = res?.has_more ? (res?.next_cursor ?? null) : null;
    } while (cursor);
    return plugins;
  }

  async getSkillArchive(id: string): Promise<AiSkillArchive> {
    const res = await ntnApi<unknown>(
      this.env,
      "GET",
      `/v1/ai/skills/${encodeURIComponent(id)}`,
    );
    return parseArchive(res);
  }
}
