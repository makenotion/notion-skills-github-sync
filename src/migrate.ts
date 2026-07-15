/**
 * `migrate` — move an existing (old-schema) customer onto a fresh typed skills
 * database (`database_type: skills`), copying rows + extra properties, then
 * re-pointing config.json at the new DB.
 *
 * Flow (see CLAUDE.md):
 *   introspect old DB -> create typed DB (same parent) -> recreate extras ->
 *   copy rows + page bodies -> reconnect-token pause -> content-parity check ->
 *   re-point config.json -> archive old DB.
 *
 * Expect exactly ONE follow-up sync commit that only rewrites the
 * `.notion-sync.json` marker provenance (pageId/url/databaseId/dataSourceId) —
 * skill content is verified identical before config.json is touched.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { WizardLogger } from "./wizard/logger.ts";
import { loggedExec } from "./wizard/exec.ts";
import { spinner } from "./wizard/spinner.ts";
import {
  addDataSourceProperties,
  createTypedSkillsDb,
  tokenCanReadDataSource,
} from "./wizard/skills-db.ts";
import { runNtn } from "./notion/ntn.ts";
import {
  CANONICAL_NAMES,
  computeMigrationMapping,
  findPropertyByRole,
  isTypedSkillsDb,
  propertyValueToWritePayload,
  type MigrationMapping,
  type PropertyLike,
} from "./notion/skill-schema.ts";
import { NtnNotionClient } from "./notion/ntn-adapter.ts";
import { resolveSkills } from "./sync.ts";
import {
  buildPluginFiles,
  stripLeadingFrontmatter,
  type NotionSourceMeta,
} from "./convert.ts";

const NOTION_VERSION = "2025-09-03";

export interface MigrateOptions {
  /** Auto-confirm every prompt (for CI/agents). */
  yes?: boolean;
}

// --- ntn helpers (logged, redacting) -----------------------------------------

async function api<T>(
  logger: WizardLogger,
  step: string,
  env: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await loggedExec(logger, step, "ntn", [
    "--env", env,
    "api", "-X", method, path,
    "--notion-version", NOTION_VERSION,
  ], { stdin: body === undefined ? undefined : JSON.stringify(body) });
  if (res.code !== 0) {
    throw new Error(
      `ntn api ${method} ${path} failed: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return JSON.parse(res.stdout) as T;
}

// --- Row copying ---------------------------------------------------------------

interface NotionRow {
  id: string;
  properties: Record<string, PropertyLike>;
}

/**
 * Build the page-creation `properties` for one migrated row: canonical roles
 * are written under their canonical display names; recreated extras keep their
 * old names. Read-only/computed values are silently skipped (they can't be
 * written; `Created by` becomes the migrating user — surfaced in the summary).
 */
export function buildMigratedRowProperties(
  oldProps: Record<string, PropertyLike>,
  mapping: MigrationMapping,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const title = findPropertyByRole(oldProps, "name")?.[1];
  const titlePayload = title && propertyValueToWritePayload(title);
  if (titlePayload) out[CANONICAL_NAMES.name] = titlePayload;

  const desc = findPropertyByRole(oldProps, "description")?.[1];
  const descPayload = desc && propertyValueToWritePayload(desc);
  if (descPayload) out[CANONICAL_NAMES.description] = descPayload;

  for (const name of Object.keys(mapping.extras)) {
    const prop = oldProps[name];
    if (!prop) continue;
    const payload = propertyValueToWritePayload(prop);
    if (payload) out[name] = payload;
  }
  return out;
}

// --- Content-parity check ------------------------------------------------------

export interface ParityResult {
  identical: boolean;
  /** Paths whose content differs beyond expected provenance/author changes. */
  diffs: string[];
  /** plugin.json author.name changes (old -> new), expected after migration. */
  authorChanges: Array<{ path: string; from: string; to: string }>;
}

/**
 * Compare the desired repo file sets generated from the old vs new DB.
 * Markers are compared minus the `notion` provenance block (pageId/url/db ids
 * legitimately change); plugin.json minus `author` (pages are re-created by
 * the migrating user — reported, not failed). Everything else must be
 * byte-identical.
 */
export function compareDesiredFiles(
  oldFiles: Record<string, string>,
  newFiles: Record<string, string>,
): ParityResult {
  const diffs: string[] = [];
  const authorChanges: ParityResult["authorChanges"] = [];
  const allPaths = new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)]);

  for (const path of allPaths) {
    const a = oldFiles[path];
    const b = newFiles[path];
    if (a === undefined || b === undefined) {
      diffs.push(path);
      continue;
    }
    if (a === b) continue;

    if (path.endsWith(".notion-sync.json")) {
      const pa = JSON.parse(a) as Record<string, unknown>;
      const pb = JSON.parse(b) as Record<string, unknown>;
      delete pa.notion;
      delete pb.notion;
      if (JSON.stringify(pa) !== JSON.stringify(pb)) diffs.push(path);
      continue;
    }
    if (path.endsWith("plugin.json")) {
      const pa = JSON.parse(a) as { author?: { name?: string } };
      const pb = JSON.parse(b) as { author?: { name?: string } };
      const from = pa.author?.name ?? "";
      const to = pb.author?.name ?? "";
      delete pa.author;
      delete pb.author;
      if (JSON.stringify(pa) !== JSON.stringify(pb)) diffs.push(path);
      else if (from !== to) authorChanges.push({ path, from, to });
      continue;
    }
    diffs.push(path);
  }

  return { identical: diffs.length === 0, diffs, authorChanges };
}

// --- Orchestration ---------------------------------------------------------------

async function confirmOrAbort(
  message: string,
  yes: boolean,
  initialValue = true,
): Promise<void> {
  if (yes) {
    p.log.info(`${message} ${pc.dim("(auto-confirmed via --yes)")}`);
    return;
  }
  const ok = await p.confirm({ message, initialValue });
  if (p.isCancel(ok) || !ok) {
    p.cancel("Migration stopped. Nothing has been re-pointed; the old DB is untouched.");
    process.exit(1);
  }
}

export async function runMigrate(opts: MigrateOptions = {}): Promise<void> {
  const yes = opts.yes === true;
  const logger = new WizardLogger();
  const config = loadConfig();
  const env = config.notionEnv;

  p.intro(pc.bold("Migrate to a typed Notion skills database"));

  // --- 1-2. Introspect the old database -------------------------------------
  const introSpin = spinner();
  introSpin.start("Reading the current skills database schema...");
  const oldDs = await api<{
    id: string;
    name?: string;
    title?: Array<{ plain_text?: string }>;
    properties: Record<string, PropertyLike>;
    parent?: { type?: string; database_id?: string };
  }>(logger, "introspect", env, "GET", `/v1/data_sources/${config.skillsDataSourceId}`);

  const oldDbId = config.skillsDatabaseId || oldDs.parent?.database_id || "";
  if (!oldDbId) {
    introSpin.stop("Could not determine the old database id.");
    throw new Error(
      "Set skillsDatabaseId in config.json (the database wrapping the data source) and re-run.",
    );
  }
  const oldDb = await api<{
    id: string;
    url?: string;
    parent?: { type?: string; page_id?: string };
    title?: Array<{ plain_text?: string }>;
  }>(logger, "introspect", env, "GET", `/v1/databases/${oldDbId}`);
  const dbName =
    oldDb.title?.map((t) => t.plain_text ?? "").join("") ||
    oldDs.name ||
    "Skills";
  introSpin.stop(`Current DB: ${pc.cyan(dbName)} (${Object.keys(oldDs.properties).length} properties)`);

  if (isTypedSkillsDb(oldDs.properties)) {
    p.outro("This database is already a typed skills database — nothing to migrate.");
    return;
  }

  // --- 3. Plan the mapping ---------------------------------------------------
  const mapping = computeMigrationMapping(oldDs.properties);
  const roleLines = Object.entries(mapping.roles).map(
    ([role, oldName]) =>
      `  ${oldName} ${pc.dim("->")} ${CANONICAL_NAMES[role as keyof typeof CANONICAL_NAMES]} ${pc.dim(`(canonical ${role})`)}`,
  );
  const extraLines = Object.keys(mapping.extras).map(
    (name) => `  ${name} ${pc.dim("(recreated as-is)")}`,
  );
  p.log.info(
    `Plan: create a new ${pc.bold("typed")} skills DB ("${dbName}", same parent), then:\n` +
      `${roleLines.join("\n")}\n${extraLines.join("\n")}` +
      (mapping.skipped.length
        ? `\n${mapping.skipped.map((s) => pc.yellow(`  ${s.name}: skipped — ${s.reason}`)).join("\n")}`
        : ""),
  );
  p.log.warn(
    "Copied pages are created by YOUR Notion user, so `Created by` (and plugin.json author) will change to you.",
  );
  await confirmOrAbort("Create the new typed database and copy everything over?", yes);

  // --- 4. Create the typed DB (same parent as the old one) --------------------
  const createSpin = spinner();
  createSpin.start("Creating the typed skills database...");
  const parentPageId =
    oldDb.parent?.type === "page_id" ? oldDb.parent.page_id : undefined;
  const created = await createTypedSkillsDb(logger, "create-db", env, {
    dbName,
    parentPageId,
  });
  if (!created.ok) {
    createSpin.stop("Failed to create the typed skills database.");
    throw new Error(created.error);
  }
  createSpin.stop(`Typed skills DB created: ${pc.cyan(created.db.databaseUrl)}`);
  const newDs = created.db.dataSourceId;

  // --- 5. Recreate extra properties (one PATCH each, so one bad property
  // doesn't block the rest) -----------------------------------------------------
  for (const [name, schema] of Object.entries(mapping.extras)) {
    const res = await addDataSourceProperties(logger, "extras", env, newDs, {
      [name]: schema,
    });
    if (!res.ok) {
      p.log.warn(`Could not recreate property "${name}" — recreate it by hand. (${res.error.slice(0, 200)})`);
    }
  }
  p.log.success(`Recreated ${Object.keys(mapping.extras).length} extra propert(ies).`);

  // --- 6. Copy rows + page bodies ---------------------------------------------
  const copySpin = spinner();
  copySpin.start("Copying rows...");
  const rows: NotionRow[] = [];
  let cursor: string | null = null;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await api<{ results: NotionRow[]; has_more: boolean; next_cursor: string | null }>(
      logger, "copy-rows", env, "POST",
      `/v1/data_sources/${config.skillsDataSourceId}/query`, body,
    );
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  let copied = 0;
  const bodyMismatches: string[] = [];
  const rowFailures: string[] = [];
  for (const row of rows) {
    const label = `row ${copied + 1}/${rows.length}`;
    copySpin.message(`Copying ${label}...`);
    try {
      const properties = buildMigratedRowProperties(row.properties, mapping);
      const createdPage = await api<{ id: string }>(
        logger, "copy-rows", env, "POST", "/v1/pages",
        { parent: { data_source_id: newDs }, properties },
      );

      // Body copy via the same Markdown pipeline the sync reads with — so the
      // parity check below exercises exactly what ends up in the repo.
      const oldBodyRes = await runNtn(env, ["pages", "get", row.id]);
      if (oldBodyRes.code !== 0) throw new Error(`could not read old body: ${oldBodyRes.stderr}`);
      const oldBody = stripLeadingFrontmatter(oldBodyRes.stdout);
      if (oldBody.trim()) {
        const update = await runNtn(env, [
          "pages", "update", createdPage.id, "--content", oldBody,
        ]);
        if (update.code !== 0) throw new Error(`could not write new body: ${update.stderr}`);
        const newBodyRes = await runNtn(env, ["pages", "get", createdPage.id]);
        const newBody = newBodyRes.code === 0 ? stripLeadingFrontmatter(newBodyRes.stdout) : "";
        if (newBody.trim() !== oldBody.trim()) bodyMismatches.push(row.id);
      }
      copied++;
    } catch (err) {
      rowFailures.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  copySpin.stop(`Copied ${copied}/${rows.length} row(s).`);
  if (rowFailures.length) {
    p.log.error(`Failed rows:\n  ${rowFailures.join("\n  ")}`);
    throw new Error("Some rows failed to copy — the old DB is untouched; fix and re-run.");
  }
  if (bodyMismatches.length) {
    p.log.warn(
      `Page-body round-trip differs for ${bodyMismatches.length} page(s) — review them in Notion:\n  ${bodyMismatches.join("\n  ")}`,
    );
  }

  // --- 7. Reconnect the sync's Notion token to the new DB ----------------------
  const envToken = process.env.NOTION_API_TOKEN?.trim();
  p.log.step(pc.bold("Reconnect the sync's Notion connection"));
  p.log.info(
    `The GitHub Action reads the DB with its own dedicated token (the ${pc.bold("NOTION_API_TOKEN")} secret).\n` +
      `That connection must be granted access to the NEW database:\n` +
      `  1. Open the new DB: ${pc.cyan(created.db.databaseUrl)}\n` +
      `  2. ••• menu -> Connections -> add your sync connection\n` +
      `(The token value itself does not change, so the GitHub secret stays as-is.)`,
  );
  if (envToken) {
    const pollSpin = spinner();
    pollSpin.start("Waiting for the sync token to see the new database...");
    const deadline = Date.now() + (yes ? 15_000 : 10 * 60_000);
    let connected = false;
    while (Date.now() < deadline) {
      connected = await tokenCanReadDataSource(logger, "reconnect", env, envToken, newDs);
      if (connected) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    pollSpin.stop(
      connected
        ? "Sync token can read the new database."
        : "Sync token still can't read the new database.",
    );
    if (!connected && !yes) {
      await confirmOrAbort("Continue anyway? (the Action will fail until the connection is added)", false, false);
    }
  } else {
    await confirmOrAbort("Have you connected the sync's connection to the new DB?", yes);
  }

  // --- 8. Content-parity check (dry-run equivalent) -----------------------------
  const paritySpin = spinner();
  paritySpin.start("Verifying content parity (old DB vs new DB -> generated repo files)...");
  const oldSkills = await resolveSkills(new NtnNotionClient(env, config.skillsDataSourceId), config);
  const newSkills = await resolveSkills(new NtnNotionClient(env, newDs), config);
  const metaOld: NotionSourceMeta = {
    env, databaseId: oldDbId, skillsDataSourceId: config.skillsDataSourceId,
  };
  const metaNew: NotionSourceMeta = {
    env, databaseId: created.db.databaseId, skillsDataSourceId: newDs,
  };
  const oldFiles: Record<string, string> = {};
  for (const s of oldSkills) Object.assign(oldFiles, buildPluginFiles(s, config.pluginsDir, metaOld));
  const newFiles: Record<string, string> = {};
  for (const s of newSkills) Object.assign(newFiles, buildPluginFiles(s, config.pluginsDir, metaNew));
  const parity = compareDesiredFiles(oldFiles, newFiles);
  paritySpin.stop(
    parity.identical
      ? `Content parity verified across ${Object.keys(oldFiles).length} file(s) (markers differ only in provenance).`
      : "Content parity check FAILED.",
  );
  for (const c of parity.authorChanges) {
    p.log.warn(`Author change (expected): ${c.path}: "${c.from}" -> "${c.to}"`);
  }
  if (!parity.identical) {
    p.log.error(`Files that differ:\n  ${parity.diffs.join("\n  ")}`);
    throw new Error(
      "Generated repo content from the new DB does not match the old DB. config.json was NOT re-pointed.",
    );
  }

  // --- 9. Re-point config.json ---------------------------------------------------
  await confirmOrAbort(
    "Re-point config.json at the new database? (commit + push it so the Action picks it up)",
    yes,
  );
  const configPath = join(process.cwd(), "config.json");
  const fileConfig = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  fileConfig.skillsDataSourceId = newDs;
  fileConfig.skillsDatabaseId = created.db.databaseId;
  writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
  p.log.success("config.json now points at the new typed database.");
  p.log.info(
    "Expect exactly ONE sync commit that rewrites `.notion-sync.json` marker provenance " +
      "(new pageId/url/db ids) and the injected updater's SKILL.md (it embeds the data " +
      "source id) — that's the migration, not a failure.",
  );

  // --- 10. Archive the old DB -----------------------------------------------------
  if (yes) {
    p.log.info(`Archiving the old database ${pc.dim("(auto-confirmed via --yes)")}`);
  }
  let archive = true;
  if (!yes) {
    const ans = await p.confirm({
      message: "Archive (trash) the OLD database now? You can also do this later in Notion.",
      initialValue: false,
    });
    archive = !p.isCancel(ans) && ans === true;
  }
  if (archive) {
    const res = await loggedExec(logger, "archive", "ntn", [
      "--env", env,
      "api", "-X", "PATCH", `/v1/databases/${oldDbId}`,
      "--notion-version", NOTION_VERSION,
    ], { stdin: JSON.stringify({ in_trash: true }) });
    if (res.code !== 0) {
      // Workspace-level databases can't be trashed via the API — hand off.
      p.log.warn(
        `Could not archive the old DB via the API (${(res.stderr || res.stdout).trim().slice(0, 160)}).\n` +
          "Trash it manually in Notion when you're ready.",
      );
    } else {
      p.log.success("Old database moved to trash.");
    }
  } else {
    p.log.info("Old database left in place — trash it in Notion once you're confident.");
  }

  const logPath = logger.finalize();
  p.outro(
    `Migration complete. New typed skills DB: ${pc.cyan(created.db.databaseUrl)}\n` +
      `   Next: commit config.json, then \`bun run dry-run\` && \`bun run sync\`.\n` +
      `   ${pc.dim(`Log: ${logPath}`)}`,
  );
}
