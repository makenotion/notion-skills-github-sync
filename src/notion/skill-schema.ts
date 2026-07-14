/**
 * The one place all Skills-DB schema knowledge lives.
 *
 * Notion "typed" skills databases (created with `database_type: skills`) carry a
 * canonical, enforced schema whose properties have stable special ids
 * (`notion://skills/*`). This module resolves logical roles (name, description,
 * …) to actual properties on a row or schema, preferring those canonical ids
 * and falling back to legacy display-name lookup for databases created by the
 * old (pre-typed) setup flow.
 *
 * Everything under the LEGACY_SHIM banner exists only to keep supporting those
 * pre-typed databases. Once every customer has been migrated (see
 * `src/migrate.ts`), that block — and the fallbacks that reference it — can be
 * deleted wholesale, leaving pure canonical-id resolution behind.
 */

// --- Canonical typed-skills property ids -------------------------------------
// These are the stable ids Notion assigns to a typed skills DB's properties.
// The REST API returns them URL-encoded (e.g.
// `notion%3A%2F%2Fskills%2Fdescription_property`), so always compare through
// `normalizePropId()`.
export const CANONICAL = {
  name: "title",
  description: "notion://skills/description_property",
  createdBy: "notion://skills/created_by_property",
  files: "notion://skills/files_property",
} as const;

// --- Sync-specific extra properties ------------------------------------------
// `Published` (our publish gate) and `Plugins` (plugin grouping) are NOT part of
// the typed schema — they are the sync's own additions, present in both typed
// and legacy databases and always resolved by display name.
export const SYNC_EXTRA = {
  published: "Published",
  plugins: "Plugins",
} as const;

// Default `Plugins` select options seeded into a freshly created skills DB.
export const SAMPLE_PLUGIN_OPTIONS = [
  "writing-assistant",
  "research-tools",
  "productivity",
] as const;

// A Notion property value/schema object, keyed by display name on a row/schema.
export type NotionProps = Record<string, any>;

/**
 * Decode a Notion property id for comparison. REST returns canonical ids
 * URL-encoded; `title` and random legacy ids come through as-is. Malformed
 * percent-sequences are left untouched.
 */
export function normalizePropId(id: string | undefined): string {
  if (!id) return "";
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** Find a property object by its canonical id, regardless of display name. */
function findByCanonicalId(props: NotionProps, canonicalId: string): any {
  for (const value of Object.values(props)) {
    if (value && normalizePropId(value.id) === canonicalId) return value;
  }
  return undefined;
}

/**
 * Is this schema a typed skills DB? Detected by the presence of the canonical
 * `notion://skills/*` ids (description + files — the two that legacy DBs never
 * carry; `title` and a "Created by" name aren't distinctive on their own).
 */
export function isTypedSkillsDb(schema: NotionProps): boolean {
  return (
    findByCanonicalId(schema, CANONICAL.description) !== undefined &&
    findByCanonicalId(schema, CANONICAL.files) !== undefined
  );
}

// The property objects backing each logical skill role on a given row/schema.
export interface ResolvedSkillProps {
  name: any;
  description: any;
  published: any;
  createdBy: any;
  plugins: any;
}

/**
 * Resolve every logical skill role to its property object on a row or schema.
 * Canonical roles prefer the `notion://skills/*` id and fall back to a legacy
 * display-name lookup; the sync extras (`Published`/`Plugins`) are always
 * resolved by name.
 */
export function resolveSkillProps(props: NotionProps): ResolvedSkillProps {
  return {
    name:
      findByCanonicalId(props, CANONICAL.name) ??
      props[LEGACY_PROP_NAMES.name],
    description:
      findByCanonicalId(props, CANONICAL.description) ??
      props[LEGACY_PROP_NAMES.description],
    createdBy:
      findByCanonicalId(props, CANONICAL.createdBy) ??
      props[LEGACY_PROP_NAMES.createdBy],
    // Sync extras: our own additions in both typed and legacy DBs.
    published: props[SYNC_EXTRA.published],
    plugins: props[SYNC_EXTRA.plugins],
  };
}

// --- Value readers ------------------------------------------------------------
// Small, role-agnostic extractors for the property shapes the sync consumes.
function richTextToPlain(rt: Array<{ plain_text?: string }> | undefined): string {
  if (!rt) return "";
  return rt.map((t) => t.plain_text ?? "").join("");
}

export function readTitle(prop: any): string {
  return richTextToPlain(prop?.title);
}

export function readRichText(prop: any): string {
  return richTextToPlain(prop?.rich_text);
}

export function readCheckbox(prop: any): boolean {
  return prop?.type === "checkbox" ? prop.checkbox === true : false;
}

export function readCreatedByName(prop: any): string {
  return prop?.created_by?.name ?? "";
}

export function readSelectName(prop: any): string | undefined {
  return prop?.type === "select" && prop.select?.name ? prop.select.name : undefined;
}

/**
 * The sync's extra properties as a `PATCH /v1/data_sources/{id}` payload,
 * layered on top of a freshly created typed skills DB. Shared by setup and
 * migrate. Pass `pluginOptions` to seed different `Plugins` select options
 * (migration reuses the source DB's options); defaults to the samples.
 */
export function desiredExtraProperties(
  pluginOptions: readonly string[] = SAMPLE_PLUGIN_OPTIONS,
): Record<string, unknown> {
  return {
    [SYNC_EXTRA.published]: { checkbox: {} },
    [SYNC_EXTRA.plugins]: {
      select: { options: pluginOptions.map((name) => ({ name })) },
    },
  };
}

// ---------------------------------------------------------------------------
// LEGACY_SHIM: everything below supports pre-typed databases created by the
// old setup flow (which hand-added properties with these exact display names).
// Once all customers are migrated onto typed skills DBs (see the `migrate`
// command), delete this block and the fallbacks in `resolveSkillProps` that
// reference it.
// ---------------------------------------------------------------------------
export const LEGACY_PROP_NAMES = {
  name: "Skill name",
  description: "Description",
  createdBy: "Created by",
} as const;
