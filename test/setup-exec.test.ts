import { expect, test, describe } from "bun:test";
import { exec, commandExists } from "../src/setup/exec.ts";

describe("exec", () => {
  test("runs a command and returns stdout", async () => {
    const result = await exec("echo", ["hello"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("returns non-zero code for failing commands", async () => {
    const result = await exec("false", []);
    expect(result.code).not.toBe(0);
  });

  test("captures stderr", async () => {
    const result = await exec("bash", ["-c", "echo err >&2"]);
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe("err");
  });
});

describe("commandExists", () => {
  test("returns true for echo", async () => {
    expect(await commandExists("echo")).toBe(true);
  });

  test("returns false for nonexistent command", async () => {
    expect(await commandExists("__nonexistent_cmd_xyz__")).toBe(false);
  });
});
