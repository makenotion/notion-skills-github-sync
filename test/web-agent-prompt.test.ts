import { describe, expect, test } from "bun:test";
import { buildEjectPrompt, truncateLog } from "../src/web/agent-prompt.ts";

describe("buildEjectPrompt", () => {
  test("embeds the log contents, current step, and points at the code", () => {
    const prompt = buildEjectPrompt({
      logPath: "/tmp/setup.log.jsonl",
      currentStep: "credentials",
      logContents: '{"kind":"event","event":"pat-validated"}',
    });
    expect(prompt).toContain("credentials");
    expect(prompt).toContain('{"kind":"event","event":"pat-validated"}');
    expect(prompt).toContain("/tmp/setup.log.jsonl");
    expect(prompt).toContain("src/web/");
    expect(prompt).toContain("```jsonl");
  });

  test("falls back to a log-path reference when there are no contents", () => {
    const prompt = buildEjectPrompt({ logPath: "/tmp/setup.log.jsonl" });
    expect(prompt).toContain("/tmp/setup.log.jsonl");
    expect(prompt).not.toContain("```");
  });

  test("omits the step clause when the step is unknown", () => {
    const prompt = buildEjectPrompt({ logPath: "/x", logContents: "{}" });
    expect(prompt).not.toContain('on the "');
  });
});

describe("truncateLog", () => {
  test("keeps short logs verbatim", () => {
    expect(truncateLog("a\nb\nc", 100)).toBe("a\nb\nc");
  });

  test("truncates to the tail and drops the partial first line", () => {
    const big = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    const out = truncateLog(big, 40);
    expect(out).toContain("earlier log lines omitted");
    expect(out).toContain("line-199");
    // The kept tail (excluding the marker line) never exceeds the budget.
    const tail = out.split("\n").slice(1).join("\n");
    expect(tail.length).toBeLessThanOrEqual(40);
  });
});
