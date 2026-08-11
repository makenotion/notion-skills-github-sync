import { describe, expect, test } from "bun:test";
import { mapPool } from "../src/sync/pool.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapPool", () => {
  test("returns results in input order, not completion order", async () => {
    const out = await mapPool([30, 20, 10, 0], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 20, 10, 0]);
  });

  test("passes the index alongside the item", async () => {
    expect(await mapPool(["a", "b", "c"], 2, async (v, i) => `${i}${v}`)).toEqual([
      "0a",
      "1b",
      "2c",
    ]);
  });

  test("never exceeds the limit, and does use it", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  test("a limit above the item count doesn't spawn idle workers", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapPool([1, 2], 16, async () => {
      peak = Math.max(peak, ++inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  test("a non-positive limit still makes progress, serially", async () => {
    expect(await mapPool([1, 2, 3], 0, async (n) => n * 2)).toEqual([2, 4, 6]);
  });

  test("empty input calls nothing", async () => {
    let calls = 0;
    expect(
      await mapPool([], 8, async () => {
        calls++;
        return 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  test("rethrows the first failure and stops starting new work", async () => {
    const started: number[] = [];
    const run = mapPool(Array.from({ length: 20 }, (_, i) => i), 2, async (i) => {
      started.push(i);
      await tick();
      if (i === 1) throw new Error("boom");
      return i;
    });

    await expect(run).rejects.toThrow("boom");
    // The two in-flight items plus, at most, whatever a sibling worker had
    // already claimed before the rejection landed — not the whole list.
    expect(started.length).toBeLessThan(6);
  });

  test("in-flight work is awaited before the error surfaces", async () => {
    let finished = 0;
    const run = mapPool([0, 1], 2, async (i) => {
      if (i === 0) throw new Error("fail fast");
      await new Promise((r) => setTimeout(r, 20));
      finished++;
      return i;
    });

    await expect(run).rejects.toThrow("fail fast");
    expect(finished).toBe(1); // the slow sibling was not abandoned
  });
});
