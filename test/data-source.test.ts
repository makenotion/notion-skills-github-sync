// Unit tests for parsing grouping-option descriptions out of a data source, and
// for the resource's fetch-and-degrade behavior against the real HTTP client.

import { describe, expect, test } from "bun:test";
import { NotionClient, pluginOptionDescriptions, type DataSource } from "../src/notion/index.ts";

function dataSource(property: {
  name: string;
  type: "select" | "multi_select" | "status";
  options: Array<{ name: string; description?: string | null }>;
}): DataSource {
  return {
    properties: {
      [property.name]: {
        type: property.type,
        [property.type]: {
          options: property.options.map((o) => ({
            name: o.name,
            description: o.description ?? null,
          })),
        },
      },
    },
  };
}

describe("pluginOptionDescriptions", () => {
  test("reads a multi_select property's option descriptions", () => {
    const ds = dataSource({
      name: "Plugins",
      type: "multi_select",
      options: [
        { name: "Finance", description: "Skills for the Finance team" },
        { name: "EPD", description: "Skills for the EPD team" },
      ],
    });
    expect(pluginOptionDescriptions(ds)).toEqual(
      new Map([
        ["Finance", "Skills for the Finance team"],
        ["EPD", "Skills for the EPD team"],
      ]),
    );
  });

  test("also handles select and status typed grouping properties", () => {
    for (const type of ["select", "status"] as const) {
      const ds = dataSource({
        name: "Plugins",
        type,
        options: [{ name: "Writing", description: "Writing tools" }],
      });
      expect(pluginOptionDescriptions(ds)).toEqual(new Map([["Writing", "Writing tools"]]));
    }
  });

  test("omits options with no, blank, or whitespace-only descriptions", () => {
    const ds = dataSource({
      name: "Plugins",
      type: "multi_select",
      options: [
        { name: "Finance", description: "Skills for the Finance team" },
        { name: "Productivity", description: "" },
        { name: "Sync Demo", description: null },
        { name: "Blank", description: "   " },
      ],
    });
    expect(pluginOptionDescriptions(ds)).toEqual(
      new Map([["Finance", "Skills for the Finance team"]]),
    );
    expect(pluginOptionDescriptions(ds).get("Blank")).toBeUndefined();
  });

  test("trims surrounding whitespace from descriptions", () => {
    const ds = dataSource({
      name: "Plugins",
      type: "multi_select",
      options: [{ name: "Finance", description: "  padded  " }],
    });
    expect(pluginOptionDescriptions(ds).get("Finance")).toBe("padded");
  });

  test("resolves the conventional property name case-insensitively", () => {
    const ds = dataSource({
      name: "plugins",
      type: "select",
      options: [{ name: "Finance", description: "Finance skills" }],
    });
    expect(pluginOptionDescriptions(ds).get("Finance")).toBe("Finance skills");
  });

  test("honors an explicit property name", () => {
    const ds: DataSource = {
      properties: {
        Group: {
          type: "select",
          select: { options: [{ name: "Finance", description: "Finance skills" }] },
        },
      },
    };
    expect(pluginOptionDescriptions(ds, "Group").get("Finance")).toBe("Finance skills");
  });

  test("returns an empty map when the grouping property is absent", () => {
    const ds: DataSource = { properties: { Description: { type: "rich_text" } } };
    expect(pluginOptionDescriptions(ds).size).toBe(0);
  });

  test("returns an empty map for a data source with no properties", () => {
    expect(pluginOptionDescriptions({}).size).toBe(0);
  });
});

describe("DataSourceResource.pluginDescriptions", () => {
  type TestFetch = (url: string, init?: { method?: string }) => Promise<Response>;
  function client(fetch: TestFetch): NotionClient {
    return new NotionClient({
      auth: "ntn_test",
      baseUrl: "https://api.fake.notion",
      fetch,
      retry: false,
    });
  }

  test("reads the grouping option descriptions from the data source endpoint", async () => {
    const seen: string[] = [];
    const notion = client(async (url: string) => {
      seen.push(new URL(url).pathname);
      return new Response(
        JSON.stringify(
          dataSource({
            name: "Plugins",
            type: "multi_select",
            options: [{ name: "Finance", description: "Finance skills" }],
          }),
        ),
        { headers: { "content-type": "application/json" } },
      );
    });

    const map = await notion.dataSources.pluginDescriptions({ dataSourceId: "ds-42" });

    expect(seen).toEqual(["/v1/data_sources/ds-42"]);
    expect(map.get("Finance")).toBe("Finance skills");
  });

  test("degrades to an empty map and warns when the data source can't be read", async () => {
    const warnings: string[] = [];
    const notion = client(async () =>
      new Response(JSON.stringify({ code: "object_not_found", message: "not shared" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const map = await notion.dataSources.pluginDescriptions({
      dataSourceId: "ds-42",
      onWarn: (m) => warnings.push(m),
    });

    expect(map.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ds-42");
  });

  test("skips the request entirely for an empty data source id", async () => {
    let called = false;
    const notion = client(async () => {
      called = true;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    const map = await notion.dataSources.pluginDescriptions({ dataSourceId: "" });

    expect(called).toBe(false);
    expect(map.size).toBe(0);
  });
});
