import { describe, expect, test } from "bun:test";
import { buildHandoffPrompt } from "../src/wizard/handoff.ts";

describe("buildHandoffPrompt", () => {
  test("includes the step, the collapsed 'what', and the log path", () => {
    const prompt = buildHandoffPrompt({
      step: "push sync script repo",
      what: "Could not push to acme/skills.\nThe branch may have diverged.",
      logPath: "/tmp/.notion-sync-setup/setup-x.log.jsonl",
    });

    expect(prompt).toContain('"push sync script repo" step');
    // Newlines in `what` are collapsed to single spaces for a clean paste.
    expect(prompt).toContain(
      "Could not push to acme/skills. The branch may have diverged.",
    );
    expect(prompt).toContain("/tmp/.notion-sync-setup/setup-x.log.jsonl");
    expect(prompt).toContain("re-run `bun run setup`");
    expect(prompt).not.toContain("\n");
  });

  test("reads naturally when no specific step is set (the eject case)", () => {
    const prompt = buildHandoffPrompt({
      step: "",
      what: "I'd like help.",
      logPath: "/tmp/log.jsonl",
    });
    expect(prompt).toContain("needs help:");
    expect(prompt).not.toContain('step: ""');
  });
});
