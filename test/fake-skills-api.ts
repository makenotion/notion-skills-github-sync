// An isolated, in-memory implementation of Notion's Skills API.
//
// It's a `fetch`, not a stub of our client: the real `NotionClient` talks to it,
// so pagination, retries, error shaping, signed-URL downloads, gzip, tar, and
// zip expansion all run for real. Archives are built as genuine `.tar.gz` bytes
// with the same wrapper-directory convention the server uses
// (`<Page Title>/SKILL.md`), including PAX long names for non-ASCII titles.
//
// The point is to be able to express edge cases as *workspace fixtures* rather
// than as per-test mocking: a skill with no attachments, one with a nested zip,
// one with binary files, a non-ASCII title, the same skill title in two plugins,
// a skill whose version_id moves, an empty plugin, a plugin rename, several
// pages of plugins, and 429s with and without `Retry-After`.

import { gzipSync, zipSync } from "fflate";
import { makeTar, type TarInput } from "./tar-helper.ts";

export interface FakeSkillInit {
  /** Page title. The archive's wrapper directory is named after it. */
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

  /** The `.tar.gz` the API would hand back for this skill. */
  archive(): Uint8Array {
    const entries: TarInput[] = [];
    const push = (relPath: string, data: string | Uint8Array) => {
      const full = `${this.title}/${relPath}`;
      // tar-stream emits a PAX header for any name that's non-ASCII or over 100
      // bytes, which is routine for Notion page titles.
      const needsPax = full.length > 100 || /[^\x20-\x7e]/.test(full);
      entries.push(
        needsPax
          ? { name: "long-name", paxPath: full, data }
          : { name: full, data },
      );
    };

    // Notion renders SKILL.md with name/description frontmatter.
    push(
      "SKILL.md",
      `---\nname: ${this.name}\ndescription: ${this.description}\n---\n\n${this.body}`,
    );
    for (const [path, data] of Object.entries(this.attachments)) push(path, data);
    if (this.zip) {
      const zipEntries: Record<string, Uint8Array> = {};
      for (const [path, data] of Object.entries(this.zip)) {
        zipEntries[path] = typeof data === "string" ? new TextEncoder().encode(data) : data;
      }
      push(this.zipName, zipSync(zipEntries));
    }
    return gzipSync(makeTar(entries));
  }
}

class FakePlugin {
  readonly id: string;
  name: string;
  description: string;
  skills: FakeSkill[] = [];

  constructor(id: string, init: FakePluginInit) {
    this.id = id;
    this.name = init.name;
    this.description = init.description ?? `${init.name} skills.`;
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
  /** Skill ids whose archive was actually built — the fast path's assertion. */
  readonly archiveBuilds: string[] = [];
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
    for (const skill of init.skills) this.addSkill(plugin.name, skill);
    return plugin;
  }

  addSkill(pluginName: string, init: FakeSkillInit): FakeSkill {
    const plugin = this.plugin(pluginName);
    const skill = new FakeSkill(fakeNotionId(this.nextId++), init);
    plugin.skills.push(skill);
    return skill;
  }

  /** Edit a skill; the version_id moves, exactly as it would in Notion. */
  editSkill(title: string, changes: Partial<FakeSkillInit> & { versionId?: string }): FakeSkill {
    const skill = this.skill(title);
    Object.assign(skill, changes);
    skill.versionId = changes.versionId ?? `${skill.versionId}+edit`;
    return skill;
  }

  deleteSkill(title: string): void {
    for (const plugin of this.plugins) {
      plugin.skills = plugin.skills.filter((s) => s.title !== title);
    }
  }

  renamePlugin(from: string, to: string): void {
    this.plugin(from).name = to;
  }

  deletePlugin(name: string): void {
    const i = this.plugins.findIndex((p) => p.name === name);
    if (i >= 0) this.plugins.splice(i, 1);
  }

  plugin(name: string): FakePlugin {
    const plugin = this.plugins.find((p) => p.name === name);
    if (!plugin) throw new Error(`FakeSkillsApi: no plugin named "${name}"`);
    return plugin;
  }

  skill(title: string): FakeSkill {
    for (const plugin of this.plugins) {
      const skill = plugin.skills.find((s) => s.title === title);
      if (skill) return skill;
    }
    throw new Error(`FakeSkillsApi: no skill titled "${title}"`);
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

    // Signed archive download.
    if (parsed.pathname.startsWith("/archives/")) {
      const id = parsed.pathname.slice("/archives/".length);
      const skill = this.skillById(id);
      if (!skill) return this.notFound(path);
      this.downloads.push(path);
      return new Response(skill.archive(), {
        headers: { "content-type": "application/gzip" },
      });
    }

    if (init?.method && init.method !== "GET") {
      return this.errorResponse({ status: 405, body: { code: "invalid_request" } });
    }

    if (parsed.pathname === "/v1/ai/plugins") return this.listPlugins(parsed);

    if (parsed.pathname.startsWith("/v1/ai/skills/")) {
      const id = decodeURIComponent(parsed.pathname.slice("/v1/ai/skills/".length));
      const skill = this.skillById(id);
      if (!skill) return this.notFound(path);
      // Building an archive is real server-side work; record that it happened.
      this.archiveBuilds.push(id);
      return this.json({
        id: skill.id,
        version_id: skill.versionId,
        url: `https://files.fake.notion/archives/${skill.id}?token=signed`,
      });
    }

    // Anything else is a route that doesn't exist — the same 400 the real API
    // gives for a stale route.
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
      results: page.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        version_id: `pv-${plugin.skills.map((s) => s.versionId).join("-")}`,
        skills: plugin.skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          updated_at: "2026-08-04T00:00:00.000Z",
          version_id: skill.versionId,
        })),
      })),
      has_more: hasMore,
      next_cursor: hasMore ? String(end) : null,
    });
  }

  private skillById(id: string): FakeSkill | undefined {
    for (const plugin of this.plugins) {
      const skill = plugin.skills.find((s) => s.id === id);
      if (skill) return skill;
    }
    return undefined;
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
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function kebab(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
