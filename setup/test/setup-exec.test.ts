import { expect, test, describe } from "bun:test";
import {
  exec,
  commandExists,
  parseGithubRepo,
  clipboardCommands,
} from "../exec.ts";

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

describe("clipboardCommands", () => {
  test("uses the native tool on macOS and Windows", () => {
    expect(clipboardCommands("darwin")).toEqual([["pbcopy"]]);
    expect(clipboardCommands("win32")).toEqual([["clip"]]);
  });

  test("tries Wayland first, then X11 fallbacks on Linux", () => {
    expect(clipboardCommands("linux")).toEqual([
      ["wl-copy"],
      ["xclip", "-selection", "clipboard"],
      ["xsel", "--clipboard", "--input"],
    ]);
  });

  test("every candidate names a command as its first element", () => {
    for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
      for (const [cmd] of clipboardCommands(platform)) {
        expect(typeof cmd).toBe("string");
        expect(cmd!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("parseGithubRepo", () => {
  // The input is raw `git remote get-url` output, so it always has a trailing
  // newline and may or may not carry a `.git` suffix.
  test("parses https, ssh, and .git-suffixed remotes", () => {
    expect(parseGithubRepo("https://github.com/acme/skills\n")).toBe("acme/skills");
    expect(parseGithubRepo("https://github.com/acme/skills.git\n")).toBe("acme/skills");
    expect(parseGithubRepo("git@github.com:acme/skills.git\n")).toBe("acme/skills");
    expect(parseGithubRepo("git@github.com:acme/skills\n")).toBe("acme/skills");
  });

  test("returns null for a non-GitHub remote", () => {
    expect(parseGithubRepo("https://gitlab.com/acme/skills.git\n")).toBeNull();
    expect(parseGithubRepo("")).toBeNull();
  });
});
