/**
 * `migrate` — move an existing (old-schema) customer onto a fresh **typed**
 * skills DB.
 *
 * Steps (see NGS-47):
 *   1. Load config.json → old data source / database.
 *   2. Introspect the OLD schema (all properties + types + options).
 *   3. Create a NEW typed skills DB under the OLD DB's parent page.
 *   4. Mirror every OLD non-canonical property onto the NEW DB (Published,
 *      Plugins, and any user columns), preserving type + options.
 *   5. Copy every row: mapped property values + the page body.
 *   6. Confirm the sync token can read the NEW DB.
 *   7. Verify content parity (per-skill contentHash) against the OLD DB.
 *   8. Re-point config.json at the NEW DB (unless --dry-run).
 *   9. Archive the OLD DB (unless --dry-run/--keep-old).
 *
 * The pure mapping helpers (schema classification + value conversion) are
 * exported for unit testing; the orchestration lives in `runMigrate`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { ntnApi, runNtn, NOTION_API_VERSION } from "./notion/ntn.ts";
import { NtnNotionClient } from "./notion/ntn-adapter.ts";
import { WizardLogger } from "./wizard/logger.ts";
import { createTypedSkillsDb } from "./wizard/skills-db.ts";
import {
  CANONICAL,
  LEGACY_PROP_NAMES,
  SYNC_EXTRA,
  desiredExtraProperties,
  normalizePropId,
  readCheckbox,
  readRichText,
  readTitle,
  type NotionProps,
} from "./notion/skill-schema.ts";
import { assignUniqueSlugs } from "./slugify.ts";
import { contentHash, deriveDescription } from "./convert.ts";

// Property types Notion computes or manages itself — they can't be created with
// a value, so migration neither recreates them nor copies their values.
const UNCREATABLE_TYPES = new Set([
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "formula",
  "rollup",
  "unique_id",
  "relation", // cross-DB reference; can't be faithfully recreated in isolation
]);

export interface OldSchemaClassification {
  /** Display names of the properties that fill each canonical role. */
  roleNames: { name?: string; description?: string; createdBy?: string };
  /** Display names of every non-canonical ("extra") property. */
  extraNames: string[];
}

/**
 * Split an OLD data source schema into canonical roles (title / description /
 * created-by) and everything else. Roles are matched by canonical id first,
 * then legacy display name; the rest are "extras" to be mirrored.
 */
export function classifyOldSchema(schema: NotionProps): OldSchemaClassification {
  const roleNames: OldSchemaClassification["roleNames"] = {};
  const extraNames: string[] = [];

  for (const [name, def] of Object.entries(schema)) {
    const id = normalizePropId(def?.id);
    if (def?.type === "title" || id === CANONICAL.name) {
      roleNames.name = name;
    } else if (id === CANONICAL.description || name === LEGACY_PROP_NAMES.description) {
      roleNames.description = name;
    } else if (
      def?.type === "created_by" ||
      id === CANONICAL.createdBy ||
      name === LEGACY_PROP_NAMES.createdBy
    ) {
      roleNames.createdBy = name;
    } else {
      extraNames.push(name);
    }
  }
  return { roleNames, extraNames };
}

/** Sanitize select/multi_select/status options to a create-safe form. */
function optionsOf(def: any, type: string): Array<{ name: string; color?: string }> {
  return (def?.[type]?.options ?? []).map((o: any) => ({
    name: o.name,
    ...(o.color ? { color: o.color } : {}),
  }));
}

export interface ExtraPropertyDefinitions {
  /** `PATCH /v1/data_sources/{id}` `properties` payload for the new DB. */
  definitions: Record<string, unknown>;
  /** Extra properties that couldn't be recreated (computed/system types). */
  skipped: string[];
}

/**
 * Build the property DEFINITIONS to add to the NEW typed DB, mirroring the
 * OLD DB's extras. `status` degrades to `select` (the API can't create status
 * properties); computed/system types are skipped. `Published`/`Plugins` are
 * always ensured (added with defaults if the OLD DB lacked them).
 */
export function buildExtraPropertyDefinitions(
  schema: NotionProps,
  extraNames: string[],
): ExtraPropertyDefinitions {
  const definitions: Record<string, unknown> = {};
  const skipped: string[] = [];

  for (const name of extraNames) {
    const def = schema[name];
    const type: string = def?.type;
    if (!type || UNCREATABLE_TYPES.has(type)) {
      skipped.push(name);
      continue;
    }
    switch (type) {
      case "select":
        definitions[name] = { select: { options: optionsOf(def, "select") } };
        break;
      case "multi_select":
        definitions[name] = { multi_select: { options: optionsOf(def, "multi_select") } };
        break;
      case "status":
        // The API can't create status properties — preserve the values as a select.
        definitions[name] = { select: { options: optionsOf(def, "status") } };
        break;
      case "number":
        definitions[name] = {
          number: def.number?.format ? { format: def.number.format } : {},
        };
        break;
      case "rich_text":
      case "checkbox":
      case "url":
      case "email":
      case "phone_number":
      case "date":
      case "people":
      case "files":
        definitions[name] = { [type]: {} };
        break;
      default:
        skipped.push(name);
    }
  }

  // Ensure the sync's gate + grouping props exist even if the OLD DB lacked them.
  const defaults = desiredExtraProperties([]);
  if (!(SYNC_EXTRA.published in definitions)) {
    definitions[SYNC_EXTRA.published] = defaults[SYNC_EXTRA.published];
  }
  if (!(SYNC_EXTRA.plugins in definitions)) {
    definitions[SYNC_EXTRA.plugins] = defaults[SYNC_EXTRA.plugins];
  }

  return { definitions, skipped };
}

function plainToRichText(plain: string): unknown[] {
  return plain ? [{ text: { content: plain } }] : [];
}

/**
 * Build the property VALUES for a new page from an OLD page's properties,
 * mapping canonical roles onto the canonical names and copying every mirrored
 * extra. `definitions` describes which extras exist on the NEW DB (and their
 * target type, so a status→select downgrade is handled).
 */
export function buildRowProperties(
  oldProps: NotionProps,
  roleNames: OldSchemaClassification["roleNames"],
  definitions: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const nameProp = roleNames.name ? oldProps[roleNames.name] : undefined;
  out[LEGACY_PROP_NAMES.name] = { title: plainToRichText(readTitle(nameProp)) };

  if (roleNames.description) {
    out[LEGACY_PROP_NAMES.description] = {
      rich_text: plainToRichText(readRichText(oldProps[roleNames.description])),
    };
  }

  for (const [name, def] of Object.entries(definitions)) {
    const targetType = Object.keys(def as Record<string, unknown>)[0]!;
    const oldVal = oldProps[name];
    if (oldVal === undefined) continue;
    const value = convertValue(oldVal, targetType);
    if (value !== undefined) out[name] = value;
  }

  return out;
}

/** Convert one OLD property value into a create payload for `targetType`. */
function convertValue(oldVal: any, targetType: string): unknown {
  switch (targetType) {
    case "checkbox":
      return { checkbox: readCheckbox(oldVal) };
    case "rich_text":
      return { rich_text: plainToRichText(readRichText(oldVal)) };
    case "number":
      return { number: oldVal.number ?? null };
    case "select": {
      const nm = oldVal.select?.name ?? oldVal.status?.name;
      return { select: nm ? { name: nm } : null };
    }
    case "multi_select":
      return {
        multi_select: (oldVal.multi_select ?? []).map((o: any) => ({ name: o.name })),
      };
    case "date":
      return { date: oldVal.date ?? null };
    case "url":
    case "email":
    case "phone_number":
      return { [targetType]: oldVal[targetType] ?? null };
    case "people":
      return {
        people: (oldVal.people ?? [])
          .filter((p: any) => p.id)
          .map((p: any) => ({ id: p.id })),
      };
    case "files":
      // Only external files can be recreated; uploaded files aren't re-hostable.
      return {
        files: (oldVal.files ?? [])
          .filter((f: any) => f.type === "external" && f.external?.url)
          .map((f: any) => ({ name: f.name, external: { url: f.external.url } })),
      };
    default:
      return undefined;
  }
}

// --- Orchestration -----------------------------------------------------------

export interface MigrateOptions {
  dryRun?: boolean;
  keepOld?: boolean;
  yes?: boolean;
}

interface RawRow {
  id: string;
  properties: NotionProps;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function queryAllRows(env: string, dsId: string): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  let cursor: string | null = null;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await ntnApi<{
      results: RawRow[];
      has_more: boolean;
      next_cursor: string | null;
    }>(env, "POST", `/v1/data_sources/${dsId}/query`, body);
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return rows;
}

/** Per-skill content fingerprint (published rows only) — mirrors what sync hashes. */
async function fingerprint(
  env: string,
  dsId: string,
): Promise<Map<string, string>> {
  const client = new NtnNotionClient(env, dsId);
  const pages = (await client.listSkillPages()).filter((p) => p.published);
  const slugs = assignUniqueSlugs(pages, (p) => p.name);
  const map = new Map<string, string>();
  for (const page of pages) {
    const slug = slugs.get(page)!;
    const body = await client.getPageBodyMarkdown(page.pageId);
    const { description } = deriveDescription(page.description, body);
    map.set(
      slug,
      contentHash({ name: page.name.trim(), description, body }),
    );
  }
  return map;
}

function diffFingerprints(
  oldFp: Map<string, string>,
  newFp: Map<string, string>,
): string[] {
  const issues: string[] = [];
  for (const [slug, hash] of oldFp) {
    if (!newFp.has(slug)) issues.push(`missing in new DB: ${slug}`);
    else if (newFp.get(slug) !== hash) issues.push(`content differs: ${slug}`);
  }
  for (const slug of newFp.keys()) {
    if (!oldFp.has(slug)) issues.push(`unexpected in new DB: ${slug}`);
  }
  return issues;
}

export async function runMigrate(opts: MigrateOptions = {}): Promise<void> {
  const config = loadConfig();
  const env = config.notionEnv;
  const oldDsId = config.skillsDataSourceId;
  const logger = new WizardLogger();

  log(`Migrating skills DB in "${env}" onto a typed skills database.`);
  log(`  Old data source: ${oldDsId}`);
  if (opts.dryRun) log("  (dry run — will create the new DB + copy data, but NOT repoint config or archive)");

  // 2. Introspect the OLD schema + locate its parent page.
  const oldSchema = await ntnApi<{ properties: NotionProps; parent?: any }>(
    env, "GET", `/v1/data_sources/${oldDsId}`,
  );
  const oldDbId = config.skillsDatabaseId || oldSchema.parent?.database_id;
  if (!oldDbId) {
    throw new Error("Could not determine the old database id (set skillsDatabaseId in config.json).");
  }
  const oldDb = await ntnApi<{ parent?: any; title?: any[]; url?: string }>(
    env, "GET", `/v1/databases/${oldDbId}`,
  );
  const parentPageId = oldDb.parent?.page_id;
  if (!parentPageId) {
    throw new Error(
      "The old database isn't parented to a page, so a typed DB can't be created " +
        "alongside it. Move the database under a page and retry.",
    );
  }
  const oldTitle =
    (oldDb.title ?? []).map((t: any) => t.plain_text ?? "").join("") || "Skills";

  const { roleNames, extraNames } = classifyOldSchema(oldSchema.properties);
  log(`  Canonical roles: ${JSON.stringify(roleNames)}`);
  log(`  Extra columns to mirror: ${extraNames.join(", ") || "(none)"}`);

  // 3. Create the NEW typed skills DB under the same parent page.
  const created = await createTypedSkillsDb(logger, "migrate", env, {
    dbName: oldTitle,
    parentPageId,
  });
  if (!created.ok) throw new Error(`Failed to create the typed skills DB: ${created.error}`);
  const newDsId = created.db.dataSourceId;
  const newDbId = created.db.databaseId;
  log(`✓ Created typed skills DB: ${created.db.databaseUrl}`);

  // 4. Mirror the OLD extras onto the NEW DB.
  const { definitions, skipped } = buildExtraPropertyDefinitions(oldSchema.properties, extraNames);
  if (skipped.length) {
    log(`  ⚠ Skipped un-recreatable columns (computed/system): ${skipped.join(", ")}`);
  }
  if (Object.keys(definitions).length) {
    await ntnApi(env, "PATCH", `/v1/data_sources/${newDsId}`, { properties: definitions });
    log(`✓ Added ${Object.keys(definitions).length} extra properties to the new DB.`);
  }

  // 5. Copy every row (properties + body).
  const rows = await queryAllRows(env, oldDsId);
  log(`Copying ${rows.length} row(s)...`);
  const oldClient = new NtnNotionClient(env, oldDsId);
  let copied = 0;
  for (const row of rows) {
    const properties = buildRowProperties(row.properties, roleNames, definitions);
    const created = await ntnApi<{ id: string }>(env, "POST", "/v1/pages", {
      parent: { data_source_id: newDsId },
      properties,
    });
    // Copy the page body verbatim via a Markdown round-trip.
    const body = await oldClient.getPageBodyMarkdown(row.id);
    if (body.trim()) {
      const edit = await runNtn(env, ["pages", "edit", created.id, "--content", body]);
      if (edit.code !== 0) {
        log(`  ⚠ Could not copy body for page ${created.id}: ${edit.stderr.trim().slice(0, 200)}`);
      }
    }
    copied++;
  }
  log(`✓ Copied ${copied}/${rows.length} rows.`);

  // 6. Confirm the sync token can read the new DB.
  try {
    await ntnApi(env, "GET", `/v1/data_sources/${newDsId}`);
    log("✓ The sync token can read the new DB.");
  } catch (err) {
    log(
      `⚠ The current token can't read the new DB yet. Connect your Notion integration to it, ` +
        `then re-run verification. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // 7. Verify content parity (published skills).
  log("Verifying content parity (published skills)...");
  const [oldFp, newFp] = await Promise.all([
    fingerprint(env, oldDsId),
    fingerprint(env, newDsId),
  ]);
  const issues = diffFingerprints(oldFp, newFp);
  if (issues.length === 0) {
    log(`✓ Content parity confirmed for ${oldFp.size} published skill(s).`);
  } else {
    log(`⚠ Content parity issues:`);
    for (const issue of issues) log(`    - ${issue}`);
  }

  // 8 + 9. Re-point config + archive (skipped on dry-run).
  if (opts.dryRun) {
    log("");
    log("Dry run complete. New DB created and populated, config.json untouched.");
    log(`  New data source: ${newDsId}`);
    log(`  New database:    ${created.db.databaseUrl}`);
    log("  Review it, then re-run without --dry-run to repoint config.json and archive the old DB.");
    logger.finalize();
    return;
  }

  const canProceed = opts.yes || process.stdout.isTTY;
  if (!canProceed) {
    log("⚠ Refusing to repoint config.json / archive without --yes on a non-interactive run.");
    log(`  New data source ready at ${newDsId}. Re-run with --yes to finalize.`);
    logger.finalize();
    return;
  }

  // Re-point config.json at the new DB.
  const configPath = join(process.cwd(), "config.json");
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  raw.skillsDataSourceId = newDsId;
  raw.skillsDatabaseId = newDbId;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  log(`✓ Re-pointed config.json at the new DB (${newDsId}).`);

  if (issues.length > 0 && !opts.yes) {
    log("⚠ Content parity issues above — leaving the old DB in place. Review before archiving.");
  } else if (opts.keepOld) {
    log("  Leaving the old DB in place (--keep-old).");
  } else {
    await ntnApi(env, "PATCH", `/v1/databases/${oldDbId}`, { archived: true });
    log(`✓ Archived the old database (${oldDbId}).`);
  }

  log("");
  log("Migration complete. Run `bun run sync` to publish from the new typed DB.");
  logger.finalize();
}
