/**
 * All knowledge about the Notion skills-database schema lives here — both the
 * canonical typed schema (`database_type: skills`) and the legacy schema the
 * old setup flow hand-built. Nothing else in the codebase should hardcode a
 * skills property name or id.
 *
 * Typed skills DBs carry stable special property ids (`notion://skills/*`),
 * which is how we detect them and resolve properties regardless of display
 * name. Legacy support is fenced in the LEGACY_SHIM block at the bottom so it
 * can be deleted wholesale once all customers are migrated (see `migrate`).
 */

// Canonical property ids on a typed skills database.
export const CANONICAL_IDS = {
  name: "title",
  description: "notion://skills/description_property",
  createdBy: "notion://skills/created_by_property",
  files: "notion://skills/files_property",
} as const;

export type CanonicalRole = keyof typeof CANONICAL_IDS;

// Display names the typed schema uses for the canonical properties. Writes
// (page creation during setup/migrate) address properties by these names.
export const CANONICAL_NAMES: Record<CanonicalRole, string> = {
  name: "Skill name",
  description: "Description",
  createdBy: "Created by",
  files: "Files",
};

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

// --- Migration property mapping ----------------------------------------------

export interface MigrationMapping {
  /** Canonical role -> old property display name that fills it. */
  roles: Partial<Record<CanonicalRole, string>>;
  /** Old non-canonical properties to recreate verbatim: name -> schema def for PATCH. */
  extras: Record<string, unknown>;
  /** Old properties that cannot be recreated via the API, with the reason. */
  skipped: Array<{ name: string; type: string; reason: string }>;
}

// Property types whose *schema* cannot be (re)created via the public API.
const UNCREATABLE_TYPES = new Set(["status", "unique_id", "button", "verification"]);

// Config keys that carry server-assigned ids we must strip before recreating.
function sanitizePropertySchema(prop: PropertyLike): unknown {
  const type = prop.type ?? "";
  const config = (prop as Record<string, unknown>)[type];
  if (type === "select" || type === "multi_select") {
    const options = ((config as { options?: Array<{ name: string; color?: string }> })
      ?.options ?? []).map((o) => ({ name: o.name, color: o.color }));
    return { [type]: { options } };
  }
  // Everything else: pass the config through as-is (empty objects for simple
  // types; relation/formula/rollup keep their target/expression config).
  return { [type]: config ?? {} };
}

/**
 * Map an old data source schema onto a fresh typed skills DB: canonical roles
 * are filled by role-matching (id first, legacy names second); every other old
 * property is recreated verbatim as an extra.
 */
export function computeMigrationMapping(
  oldSchema: Record<string, PropertyLike>,
): MigrationMapping {
  const roles: Partial<Record<CanonicalRole, string>> = {};
  const claimed = new Set<string>();
  for (const role of Object.keys(CANONICAL_IDS) as CanonicalRole[]) {
    const found = findPropertyByRole(oldSchema, role);
    if (found && !claimed.has(found[0])) {
      roles[role] = found[0];
      claimed.add(found[0]);
    }
  }

  const extras: Record<string, unknown> = {};
  const skipped: MigrationMapping["skipped"] = [];
  for (const [name, prop] of Object.entries(oldSchema)) {
    if (claimed.has(name)) continue;
    const type = prop.type ?? "unknown";
    if (type === "title") {
      // A second title property can't exist; the role pass always claims it.
      continue;
    }
    if (UNCREATABLE_TYPES.has(type)) {
      skipped.push({
        name,
        type,
        reason: `\`${type}\` properties cannot be created via the API — recreate it by hand if still needed`,
      });
      continue;
    }
    extras[name] = sanitizePropertySchema(prop);
  }

  return { roles, extras, skipped };
}

// Property value types we can copy row-by-row during migration. System-managed
// and computed types are excluded (their values can't be written).
const COPYABLE_VALUE_TYPES = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "date",
  "people",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "relation",
]);

/**
 * Convert a property value from a query response into a write payload for page
 * creation, or null if the type isn't copyable (system/computed types).
 */
export function propertyValueToWritePayload(prop: PropertyLike): unknown | null {
  const type = prop.type ?? "";
  if (!COPYABLE_VALUE_TYPES.has(type)) return null;
  const value = (prop as Record<string, unknown>)[type];
  if (value === null || value === undefined) return null;
  switch (type) {
    case "select": {
      const name = (value as { name?: string }).name;
      return name ? { select: { name } } : null;
    }
    case "multi_select":
      return {
        multi_select: (value as Array<{ name: string }>).map((o) => ({ name: o.name })),
      };
    case "people":
      return { people: (value as Array<{ id: string }>).map((u) => ({ id: u.id })) };
    case "relation":
      return { relation: (value as Array<{ id: string }>).map((r) => ({ id: r.id })) };
    default:
      return { [type]: value };
  }
}

// ---------------------------------------------------------------------------
// LEGACY_SHIM: everything below supports pre-typed databases created by the
// old setup flow (plain DB + hand-added properties, no special ids). Once all
// customers are migrated (see the `migrate` command), delete this whole block
// and the fallbacks that reference it.
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
