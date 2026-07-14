import type { NotionClient, NotionSkillPage } from "./types.ts";
import { stripLeadingFrontmatter } from "../convert.ts";
import { ntnApi, runNtn } from "./ntn.ts";
import {
  readCheckbox,
  readCreatedByName,
  readRichText,
  readSelectName,
  readTitle,
  resolveSkillProps,
} from "./skill-schema.ts";

interface QueryResponse {
  results: NotionRow[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionRow {
  id: string;
  last_edited_time: string;
  properties: Record<string, any>;
}

function parseRow(row: NotionRow): NotionSkillPage {
  // All property-name/id knowledge lives in the schema shim, so this works for
  // both typed skills DBs (canonical ids) and legacy DBs (display names).
  const fields = resolveSkillProps(row.properties ?? {});

  return {
    pageId: row.id,
    name: readTitle(fields.name),
    description: readRichText(fields.description),
    published: readCheckbox(fields.published),
    createdBy: readCreatedByName(fields.createdBy),
    lastEditedTime: row.last_edited_time ?? "",
    plugin: readSelectName(fields.plugins),
  };
}

export class NtnNotionClient implements NotionClient {
  constructor(
    private readonly env: string,
    private readonly dataSourceId: string,
  ) {}

  async listSkillPages(): Promise<NotionSkillPage[]> {
    const pages: NotionSkillPage[] = [];
    let cursor: string | null = null;
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const res: QueryResponse = await ntnApi<QueryResponse>(
        this.env,
        "POST",
        `/v1/data_sources/${this.dataSourceId}/query`,
        body,
      );
      for (const row of res.results) pages.push(parseRow(row));
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    return pages;
  }

  async getPageBodyMarkdown(pageId: string): Promise<string> {
    const res = await runNtn(this.env, ["pages", "get", pageId]);
    if (res.code !== 0) {
      throw new Error(
        `ntn pages get ${pageId} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    return stripLeadingFrontmatter(res.stdout);
  }
}
