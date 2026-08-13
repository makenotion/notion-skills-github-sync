// Reading the grouping property's option descriptions from a Notion data source.
//
// Skills are grouped into plugins by a property on the skills database —
// conventionally a select / multi-select / status property named "Plugins".
// Each option on that property *is* a plugin, so the option's description is the
// natural, owner-controlled source for that plugin's description.
//
// The Plugins API's own plugin-level `description` is not a reliable authoring
// surface: it can fall back to an arbitrary skill's description, and a DB owner
// has no dependable way to set it. So the sync reads the option description here
// and treats it as authoritative when present.
//
// This is the ONE place the sync looks past the Plugins API into a data source's
// schema, and it reads *schema only* — never skill rows. Grouping and skill
// content still come entirely from the plugin archive; this only supplies a
// per-plugin description. The Notion half stays importable on its own: nothing
// here reaches into src/sync/ or src/target/.

import { type NotionHttp } from "./http.ts";

/** The property that groups skills into plugins, by convention. */
export const DEFAULT_PLUGIN_PROPERTY = "Plugins";

/** An option on a select / multi-select / status property. */
interface PropertyOption {
  name?: string;
  /** Present since Notion API 2025-09-03; may be null/absent. */
  description?: string | null;
}

interface DataSourceProperty {
  type?: string;
  select?: { options?: PropertyOption[] };
  multi_select?: { options?: PropertyOption[] };
  status?: { options?: PropertyOption[] };
}

/** The slice of `GET /v1/data_sources/{id}` this module needs. */
export interface DataSource {
  properties?: Record<string, DataSourceProperty>;
}

/**
 * Map each grouping-option name to its trimmed, non-empty description.
 *
 * PURE: split from the transport so the parsing — which has to tolerate three
 * property types and blank/whitespace descriptions — is unit-testable on its
 * own. Options with no usable description are simply omitted, so the caller can
 * treat a missing key as "fall back to the API description".
 */
export function pluginOptionDescriptions(
  dataSource: DataSource,
  property: string = DEFAULT_PLUGIN_PROPERTY,
): Map<string, string> {
  const result = new Map<string, string>();
  const props = dataSource.properties ?? {};

  // Prefer the conventional name; match case-insensitively as a fallback so a
  // "plugins" column still resolves.
  const entry =
    props[property] ??
    Object.entries(props).find(([name]) => name.toLowerCase() === property.toLowerCase())?.[1];
  if (!entry) return result;

  // The property may be select, multi-select, or status — a DB owner picks
  // whichever, and all three carry `{ name, description }` options.
  const options =
    entry.select?.options ?? entry.multi_select?.options ?? entry.status?.options;
  if (!options) return result;

  for (const option of options) {
    const name = option.name?.trim();
    const description = option.description?.trim();
    if (name && description) result.set(name, description);
  }
  return result;
}

export class DataSourceResource {
  constructor(private readonly http: NotionHttp) {}

  /**
   * The grouping property's option descriptions, keyed by option name.
   *
   * Never throws: the override is an enhancement, and an unset, unshared, or
   * feature-gated data source must degrade to the API's own descriptions rather
   * than fail an otherwise-healthy sync. A read failure is surfaced through
   * `onWarn` and reported as an empty map.
   */
  async pluginDescriptions(args: {
    dataSourceId: string;
    property?: string;
    onWarn?: (message: string) => void;
  }): Promise<Map<string, string>> {
    if (!args.dataSourceId) return new Map();

    let dataSource: DataSource;
    try {
      dataSource = await this.http.request<DataSource>({
        path: `/v1/data_sources/${encodeURIComponent(args.dataSourceId)}`,
      });
    } catch (err) {
      args.onWarn?.(
        `Could not read plugin descriptions from the skills data source ` +
          `(${args.dataSourceId}); using the API's plugin descriptions instead. ` +
          `Share the skills database with the sync's Notion connection to enable ` +
          `option-description overrides.\n  ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Map();
    }

    return pluginOptionDescriptions(dataSource, args.property ?? DEFAULT_PLUGIN_PROPERTY);
  }
}
