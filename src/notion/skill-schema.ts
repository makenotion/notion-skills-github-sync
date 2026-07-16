/**
 * All knowledge about the Notion skills-database schema lives here — both the
 * canonical typed schema (`database_type: skills`) and the legacy schema the
 * old setup flow hand-built. Nothing else in the codebase should hardcode a
 * skills property name or id.
 *
 * Typed skills DBs carry stable special property ids (`notion://skills/*`),
 * which is how we detect them and resolve properties regardless of display
 * name. Legacy support is fenced in the LEGACY_SHIM block at the bottom. NOTE:
 * it can't just be deleted "once everyone's on typed DBs" — Notion's in-product
 * conversion ("Turn into Skills DB") keeps the DB's original plain property ids
 * over the REST API (no canonical `notion://skills/*` ids surface), so converted
 * DBs resolve *through the shim*. Only DBs freshly created as typed (our setup's
 * tools/run path) expose canonical ids. See the conversion gotcha in CLAUDE.md.
 */

// Canonical property ids on a typed skills database.
export const CANONICAL_IDS = {
  name: "title",
  description: "notion://skills/description_property",
  createdBy: "notion://skills/created_by_property",
  files: "notion://skills/files_property",
} as const;

export type CanonicalRole = keyof typeof CANONICAL_IDS;

// Sync-specific extras — our own additions on top of the typed schema, present
// in both typed and legacy DBs. Always resolved by display name.
export const EXTRA_PROP_NAMES = {
  published: "Published",
  plugins: "Plugins",
} as const;

export const DEFAULT_PLUGIN_OPTIONS = [
  "writing-assistant",
  "research-tools",
  "productivity",
];

/** The data-source PATCH body adding the sync's extra properties. */
export function desiredExtraProperties(
  pluginOptions: string[] = DEFAULT_PLUGIN_OPTIONS,
): Record<string, unknown> {
  return {
    [EXTRA_PROP_NAMES.published]: { checkbox: {} },
    [EXTRA_PROP_NAMES.plugins]: {
      select: { options: pluginOptions.map((name) => ({ name })) },
    },
  };
}

// A property as it appears in a row's `properties` or a data source's schema.
export interface PropertyLike {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

// REST responses URL-encode special property ids
// ("notion%3A%2F%2Fskills%2Fdescription_property").
export function decodePropertyId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** A typed skills DB is detected by the presence of any canonical special id. */
export function isTypedSkillsDb(
  schemaProperties: Record<string, PropertyLike>,
): boolean {
  return Object.values(schemaProperties).some((p) =>
    decodePropertyId(String(p?.id ?? "")).startsWith("notion://skills/"),
  );
}

/**
 * Find a canonical property (in a row or a schema) by role. Prefers the
 * canonical special id; falls back to the legacy shim for pre-typed DBs.
 * Returns [displayName, property] or undefined.
 */
export function findPropertyByRole(
  props: Record<string, PropertyLike>,
  role: CanonicalRole,
): [string, PropertyLike] | undefined {
  const canonicalId = CANONICAL_IDS[role];
  for (const [name, value] of Object.entries(props)) {
    if (value?.id !== undefined && decodePropertyId(String(value.id)) === canonicalId) {
      return [name, value];
    }
  }
  return legacyFindPropertyByRole(props, role);
}

function richTextToPlain(rt: Array<{ plain_text?: string }> | undefined): string {
  if (!rt) return "";
  return rt.map((t) => t.plain_text ?? "").join("");
}

// The logical skill fields the sync consumes, resolved from a row.
export interface ResolvedSkillFields {
  name: string;
  description: string;
  published: boolean;
  createdBy: string;
  plugin?: string;
}

/** Resolve a row's properties to logical skill fields (typed or legacy DBs). */
export function resolveSkillFields(
  props: Record<string, PropertyLike>,
): ResolvedSkillFields {
  const nameProp = findPropertyByRole(props, "name")?.[1];
  const descProp = findPropertyByRole(props, "description")?.[1];
  const createdByProp = findPropertyByRole(props, "createdBy")?.[1];
  const pubProp = props[EXTRA_PROP_NAMES.published];
  const pluginsProp = props[EXTRA_PROP_NAMES.plugins];

  const pluginValue =
    pluginsProp?.type === "select" &&
    (pluginsProp.select as { name?: string } | null)?.name
      ? (pluginsProp.select as { name: string }).name
      : undefined;

  return {
    name: richTextToPlain(nameProp?.title as never),
    description: richTextToPlain(descProp?.rich_text as never),
    published: pubProp?.type === "checkbox" ? pubProp.checkbox === true : false,
    createdBy:
      ((createdByProp?.created_by as { name?: string } | undefined)?.name) ?? "",
    plugin: pluginValue,
  };
}

// ---------------------------------------------------------------------------
// LEGACY_SHIM: everything below resolves properties by display name for DBs
// that don't surface canonical `notion://skills/*` ids over REST. That's both
// pre-typed DBs (old setup flow) AND DBs converted in-product via "Turn into
// Skills DB" (the conversion preserves original plain ids — see the header
// comment). So this is NOT safe to delete just because customers migrated;
// it's only removable if converted DBs start exposing canonical ids.
// ---------------------------------------------------------------------------

export const LEGACY_PROP_NAMES: Partial<Record<CanonicalRole, string>> = {
  name: "Skill name",
  description: "Description",
  createdBy: "Created by",
};

function legacyFindPropertyByRole(
  props: Record<string, PropertyLike>,
  role: CanonicalRole,
): [string, PropertyLike] | undefined {
  const legacyName = LEGACY_PROP_NAMES[role];
  if (legacyName && props[legacyName]) return [legacyName, props[legacyName]];
  // Every data source has exactly one title property — for the name role,
  // fall back to it whatever it's called (e.g. a never-renamed "Name").
  if (role === "name") {
    for (const [name, value] of Object.entries(props)) {
      if (value?.type === "title") return [name, value];
    }
  }
  return undefined;
}
