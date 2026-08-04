import { describe, expect, test } from "bun:test";
import { slugify, assignUniqueSlugs } from "../src/sync/slugify.ts";

describe("slugify", () => {
  test("basic + trailing whitespace", () => {
    expect(slugify("Message Review ")).toBe("message-review");
    expect(slugify("Product Thinking First Pass")).toBe("product-thinking-first-pass");
    expect(slugify("Customer Feedback Collection")).toBe("customer-feedback-collection");
  });

  test("punctuation and casing", () => {
    expect(slugify("Hello, World! (v2)")).toBe("hello-world-v2");
    expect(slugify("  --Spaces--  ")).toBe("spaces");
    expect(slugify("Café Résumé")).toBe("cafe-resume");
  });

  test("empty / symbol-only slug becomes empty string", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

describe("assignUniqueSlugs", () => {
  test("dedupes collisions in order", () => {
    const items = [{ n: "Deploy" }, { n: "deploy" }, { n: "Deploy!" }];
    const map = assignUniqueSlugs(items, (i) => i.n);
    expect(map.get(items[0]!)).toBe("deploy");
    expect(map.get(items[1]!)).toBe("deploy-2");
    expect(map.get(items[2]!)).toBe("deploy-3");
  });

  test("empty slug falls back to 'skill'", () => {
    const items = [{ n: "!!!" }, { n: "@@@" }];
    const map = assignUniqueSlugs(items, (i) => i.n);
    expect(map.get(items[0]!)).toBe("skill");
    expect(map.get(items[1]!)).toBe("skill-2");
  });
});
