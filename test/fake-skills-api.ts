// An isolated, in-memory implementation of Notion's Plugins API.
//
// It's a `fetch`, not a stub of our client: the real `NotionClient` talks to it,
// so pagination, retries, error shaping, signed-URL downloads, gzip, tar, and
// zip expansion all run for real. A plugin's archive is built as genuine
// `.tar.gz` bytes in the Agent Plugins 1.0 layout the server uses — a
// `plugin.json` at the root and every skill under `skills/<slug>/` — wrapped in
// one top-level directory named after the plugin, with PAX long names for
// non-ASCII entries.
//
// The point is to be able to express edge cases as *workspace fixtures* rather
// than as per-test mocking: a skill with no attachments, one with a nested zip,
// one with binary files, a non-ASCII title, the same skill title in two plugins,
// an empty plugin, a plugin whose files change or are deleted, a deleted plugin,
// several pages of plugins, and 429s with and without `Retry-After`.

import { gzipSync, zipSync } from "fflate";
import { assignUniqueSlugs } from "../src/sync/slugify.ts";
import { makeTar, type TarInput } from "./tar-helper.ts";

export interface FakeSkillInit {
  /** Page title. Its slug becomes the skill's `skills/<dir>/` name. */
  title: string;
  /** Kebab-cased name the API reports. Derived from the title if omitted. */
  name?: string;
  description?: string;
  /** SKILL.md body, as the API would render it. */
  body?: string;
  /** Loose attachments, flattened next to SKILL.md in the archive. */
  attachments?: Record<string, string | Uint8Array>;
  /**
   * Contents of a single attached `.zip`, which the API archives verbatim and
   * the sync is expected to expand in place.
   */
  zip?: Record<string, string | Uint8Array>;
  /** Name of that zip attachment. */
  zipName?: string;
  versionId?: string;
}

export interface FakePluginInit {
  name: string;
  description?: string;
  /** Opaque plugin-root files in addition to the default plugin.json. */
  files?: Record<string, string | Uint8Array>;
  skills: FakeSkillInit[];
}

class FakeSkill {
  title: string;
  name: string;
  description: string;
  body: string;
  attachments: Record<string, string | Uint8Array>;
  zip: Record<string, string | Uint8Array> | undefined;
  zipName: string;
  versionId: string;
  readonly id: string;

  constructor(id: string, init: FakeSkillInit) {
    this.id = id;
    this.title = init.title;
    this.name = init.name ?? kebab(init.title);
    this.description = init.description ?? `What ${init.title} is for.`;
    this.body = init.body ?? `# ${init.title}\n\nInstructions for ${init.title}.\n`;
    this.attachments = init.attachments ?? {};
    this.zip = init.zip;
    this.zipName = init.zipName ?? "files.zip";
    this.versionId = init.versionId ?? "v1";
  }

  /** Skill-dir-relative files: the rendered SKILL.md plus any attachments. */
  files(): Record<string, string | Uint8Array> {
    const files: Record<string, string | Uint8Array> = {
      // Notion renders SKILL.md with name/description frontmatter.
      "SKILL.md": `---\nname: ${this.name}\ndescription: ${this.description}\n---\n\n${this.body}`,
    };
    for (const [path, data] of Object.entries(this.attachments)) files[path] = data;
    if (this.zip) {
      const zipEntries: Record<string, Uint8Array> = {};
      for (const [path, data] of Object.entries(this.zip)) {
        zipEntries[path] = typeof data === "string" ? new TextEncoder().encode(data) : data;
      }
      files[this.zipName] = zipSync(zipEntries);
    }
    return files;
  }
}

class FakePlugin {
  readonly id: string;
  name: string;
  description: string;
  files: Record<string, string | Uint8Array>;
  skills: FakeSkill[] = [];
  private revision = 1;

  constructor(id: string, init: FakePluginInit) {
    this.id = id;
    this.name = init.name;
    this.description = init.description ?? `${init.name} skills.`;
    this.files = { ...(init.files ?? {}) };
  }

  /** Opaque version that moves when any skill's does — like the real API. */
  get versionId(): string {
    return `pv-${this.revision}-${this.skills.map((s) => s.versionId).join("-")}`;
  }

  touch(): void {
    this.revision++;
  }

  /** The `.tar.gz` the API hands back for this whole plugin. */
  archive(): Uint8Array {
    // Skill directory names, made unique within the plugin exactly as the sync
    // slugifies them, so the archive lays out the way Notion's would.
    const dirs = assignUniqueSlugs(this.skills, (s) => s.name);
    // One wrapping directory, named after the plugin the way Notion names it:
    // the kebab-cased slug (`sync-demo`), not the display name. A plugin with no
    // usable name still gets a non-empty root — an empty one would make every
    // entry an absolute path and get the whole archive rejected as unsafe.
    const root = kebab(this.name) || "plugin";

    const entries: TarInput[] = [];
    const push = (relPath: string, data: string | Uint8Array, forcePax = false) => {
      const full = `${root}/${relPath}`;
      // tar-stream emits a PAX header for any name that's non-ASCII or over 100
      // bytes; force it too, to keep the long-name read path exercised.
      const needsPax = forcePax || full.length > 100 || /[^\x20-\x7e]/.test(full);
      entries.push(needsPax ? { name: "long-name", paxPath: full, data } : { name: full, data });
    };

    // The canonical Agent Plugins manifest at the plugin root. The sync keeps it
    // byte-exact and derives Claude's compatibility manifest from it.
    const defaultManifest = `${JSON.stringify(
      { $schema: "https://agent-plugins.org/schema/1.0.0/plugin.json", name: kebab(this.name) },
      null,
      2,
    )}\n`;
    for (const [path, data] of Object.entries({ "plugin.json": defaultManifest, ...this.files })) {
      push(path, data);
    }

    for (const skill of this.skills) {
      const dir = dirs.get(skill)!;
      const forcePax = /[^\x20-\x7e]/.test(skill.title);
      for (const [relPath, data] of Object.entries(skill.files())) {
        push(`skills/${dir}/${relPath}`, data, forcePax && relPath === "SKILL.md");
      }
    }

    return gzipSync(makeTar(entries));
  }
}

/** A scripted failure, consumed by the next matching request. */
interface QueuedFailure {
  status: number;
  /** `Retry-After` in seconds. Omitted means the header is absent. */
  retryAfter?: number;
  body?: unknown;
  /** Only fail requests whose path contains this. */
  pathIncludes?: string;
}

export interface FakeSkillsApiOptions {
  /** Plugins per page of `/v1/ai/plugins`. Unset means one page. */
  pageSize?: number;
}

export class FakeSkillsApi {
  /** Every request path this API served, in order. */
  readonly requests: string[] = [];
  /** Plugin ids whose archive was actually built — the fast path's assertion. */
  readonly pluginArchiveBuilds: string[] = [];
  /** Signed archive URLs that were downloaded. */
  readonly downloads: string[] = [];

  private readonly plugins: FakePlugin[] = [];
  private readonly failures: QueuedFailure[] = [];
  private readonly pageSize: number | undefined;
  private nextId = 1;

  constructor(plugins: FakePluginInit[] = [], opts: FakeSkillsApiOptions = {}) {
    this.pageSize = opts.pageSize;
    for (const init of plugins) this.addPlugin(init);
  }

  // --- Workspace mutation (what a test does "in Notion") --------------------

  addPlugin(init: FakePluginInit): FakePlugin {
    const plugin = new FakePlugin(fakeNotionId(this.nextId++), init);
    this.plugins.push(plugin);
    for (const skill of init.skills) {
      plugin.skills.push(new FakeSkill(fakeNotionId(this.nextId++), skill));
    }
    return plugin;
  }

  deletePlugin(name: string): void {
    const i = this.plugins.findIndex((p) => p.name === name);
    if (i >= 0) this.plugins.splice(i, 1);
  }

  setPluginFile(name: string, path: string, content: string | Uint8Array): void {
    const plugin = this.plugin(name);
    plugin.files[path] = content;
    plugin.touch();
  }

  deletePluginFile(name: string, path: string): void {
    const plugin = this.plugin(name);
    delete plugin.files[path];
    plugin.touch();
  }

  plugin(name: string): FakePlugin {
    const plugin = this.plugins.find((p) => p.name === name);
    if (!plugin) throw new Error(`FakeSkillsApi: no plugin named "${name}"`);
    return plugin;
  }

  /** Fail the next matching request. Queue several to fail repeatedly. */
  failNext(failure: QueuedFailure): void {
    this.failures.push(failure);
  }

  // --- The fetch implementation --------------------------------------------

  readonly fetch = async (url: string, init?: { method?: string }): Promise<Response> => {
    const parsed = new URL(url);
    const path = parsed.pathname + (parsed.search || "");
    this.requests.push(path);

    const failure = this.takeFailure(path);
    if (failure) return this.errorResponse(failure);

    // Signed archive download of a whole plugin.
    if (parsed.pathname.startsWith("/archives/plugin/")) {
      const id = parsed.pathname.slice("/archives/plugin/".length);
      const plugin = this.pluginById(id);
      if (!plugin) return this.notFound(path);
      this.downloads.push(path);
      return new Response(plugin.archive(), {
        headers: { "content-type": "application/gzip" },
      });
    }

    if (init?.method && init.method !== "GET") {
      return this.errorResponse({ status: 405, body: { code: "invalid_request" } });
    }

    if (parsed.pathname === "/v1/ai/plugins") return this.listPlugins(parsed);

    if (parsed.pathname.startsWith("/v1/ai/plugins/")) {
      const id = decodeURIComponent(parsed.pathname.slice("/v1/ai/plugins/".length));
      const plugin = this.pluginById(id);
      if (!plugin) return this.notFound(path);
      // Rendering a whole plugin is real server-side work; record it happened.
      this.pluginArchiveBuilds.push(id);
      return this.json({
        id: plugin.id,
        version_id: plugin.versionId,
        url: `https://files.fake.notion/archives/plugin/${plugin.id}?token=signed`,
      });
    }

    // Anything else is a route that doesn't exist — the same 400 the real API
    // gives for a stale route (e.g. the retired /v1/ai/skills/:id).
    return this.errorResponse({
      status: 400,
      body: { code: "invalid_request_url", message: `Invalid request URL: ${path}` },
    });
  };

  private listPlugins(parsed: URL): Response {
    const cursor = parsed.searchParams.get("start_cursor");
    const start = cursor ? Number(cursor) : 0;
    const size = this.pageSize ?? this.plugins.length;
    const page = this.plugins.slice(start, start + Math.max(size, 1));
    const end = start + page.length;
    const hasMore = end < this.plugins.length;

    return this.json({
      object: "list",
      // Identity and version only. The API reports no skill-level data anywhere:
      // a plugin's skills exist solely inside its archive.
      results: page.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        version_id: plugin.versionId,
      })),
      has_more: hasMore,
      next_cursor: hasMore ? String(end) : null,
    });
  }

  private pluginById(id: string): FakePlugin | undefined {
    return this.plugins.find((p) => p.id === id);
  }

  private takeFailure(path: string): QueuedFailure | undefined {
    const i = this.failures.findIndex(
      (f) => !f.pathIncludes || path.includes(f.pathIncludes),
    );
    return i === -1 ? undefined : this.failures.splice(i, 1)[0];
  }

  private json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }

  private notFound(path: string): Response {
    return this.errorResponse({
      status: 404,
      body: { code: "object_not_found", message: `Not found: ${path}` },
    });
  }

  private errorResponse(failure: QueuedFailure): Response {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (failure.retryAfter !== undefined) headers["retry-after"] = String(failure.retryAfter);
    const body = failure.body ?? { code: "rate_limited", message: "Rate limited" };
    return new Response(JSON.stringify(body), { status: failure.status, headers });
  }
}

/**
 * A dashed, Notion-shaped page id. Realistic enough that anything deriving a URL
 * from it (the sync marker does) is exercised the way production would be.
 */
export function fakeNotionId(n: number): string {
  const hex = n.toString(16);
  // The sync's fallback directory name for an unnamed plugin comes from the id's
  // *last* 12 hex characters, so the final segment must vary per plugin or those
  // fixtures would all collide on one slug. The first segment varies too, since
  // real Notion ids differ from their first character.
  return `${hex.padStart(8, "0")}-0000-4000-8000-${hex.padStart(12, "0")}`;
}

function kebab(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
