import type { NotionClient, NotionSkillPage } from "./types.ts";
import { stripLeadingFrontmatter } from "../convert.ts";
import { ntnApi, runNtn } from "./ntn.ts";

// Property names as they appear in the "Cowork Skills" database.
const PROP_NAME = "Skill name";
const PROP_DESCRIPTION = "Description";
const PROP_PUBLISHED = "Published";
const PROP_CREATED_BY = "Created by";

function richTextToPlain(rt: Array<{ plain_text?: string }> | undefined): string {
  if (!rt) return "";
  return rt.map((t) => t.plain_text ?? "").join("");
}

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
  const props = row.properties ?? {};
  const nameProp = props[PROP_NAME];
  const descProp = props[PROP_DESCRIPTION];
  const pubProp = props[PROP_PUBLISHED];
  const createdByProp = props[PROP_CREATED_BY];

  return {
    pageId: row.id,
    name: richTextToPlain(nameProp?.title),
    description: richTextToPlain(descProp?.rich_text),
    published: pubProp?.type === "checkbox" ? pubProp.checkbox === true : false,
    createdBy: createdByProp?.created_by?.name ?? "",
    lastEditedTime: row.last_edited_time ?? "",
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
