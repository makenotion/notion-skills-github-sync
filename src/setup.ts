import type { Config } from "./config.ts";
import { ntnApi } from "./notion/ntn.ts";

const PROP_PUBLISHED = "Published";

interface DataSource {
  properties: Record<string, { type: string }>;
}

interface QueryResponse {
  results: Array<{ id: string; properties: Record<string, any> }>;
  has_more: boolean;
  next_cursor: string | null;
}

// Idempotently ensure the "Published" checkbox property exists on the data
// source, then check it on every existing row so they sync. Re-runnable: skips
// the schema change if present and only checks rows that are currently false.
export async function runSetup(config: Config): Promise<void> {
  const env = config.notionEnv;
  const dsId = config.dataSourceId;

  const ds = await ntnApi<DataSource>(env, "GET", `/v1/data_sources/${dsId}`);
  const hasPublished = Boolean(ds.properties?.[PROP_PUBLISHED]);

  if (hasPublished) {
    console.log(`✓ "${PROP_PUBLISHED}" property already exists.`);
  } else {
    console.log(`Adding "${PROP_PUBLISHED}" checkbox property...`);
    await ntnApi(env, "PATCH", `/v1/data_sources/${dsId}`, {
      properties: { [PROP_PUBLISHED]: { checkbox: {} } },
    });
    console.log(`✓ Added "${PROP_PUBLISHED}".`);
  }

  // Check the box on every row that isn't already checked.
  let cursor: string | null = null;
  let checked = 0;
  let already = 0;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await ntnApi<QueryResponse>(
      env,
      "POST",
      `/v1/data_sources/${dsId}/query`,
      body,
    );
    for (const row of res.results) {
      const current = row.properties?.[PROP_PUBLISHED]?.checkbox === true;
      if (current) {
        already++;
        continue;
      }
      await ntnApi(env, "PATCH", `/v1/pages/${row.id}`, {
        properties: { [PROP_PUBLISHED]: { checkbox: true } },
      });
      checked++;
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  console.log(`✓ Published: checked ${checked} row(s), ${already} already checked.`);
  console.log("Run `bun run sync` (or `npm run sync`) to push to GitHub.");
}
