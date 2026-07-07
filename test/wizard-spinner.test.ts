import { expect, test, describe } from "bun:test";
import { spinner } from "../src/wizard/spinner.ts";

describe("spinner", () => {
  test("never attaches stdin listeners (the clack block() hard-exit vector)", () => {
    const keypressBefore = process.stdin.listenerCount("keypress");
    const dataBefore = process.stdin.listenerCount("data");
    const pausedBefore = process.stdin.isPaused();

    const s = spinner();
    s.start("working");
    s.message("still working");
    s.stop("done");

    // The whole point: our spinner touches stdout only, never stdin — so it
    // cannot leak a listener or hard-exit(0) the process on a stray key.
    expect(process.stdin.listenerCount("keypress")).toBe(keypressBefore);
    expect(process.stdin.listenerCount("data")).toBe(dataBefore);
    expect(process.stdin.isPaused()).toBe(pausedBefore);
  });

  test("start/stop are safe to call and clear their timer", () => {
    const s = spinner();
    expect(() => {
      s.start("x");
      s.stop("y");
      s.stop("z"); // idempotent stop
    }).not.toThrow();
  });
});
