import { expect, test, describe } from "bun:test";
import { SetupLogger } from "../logger.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-setup-test");

/** Read a JSONL log file into an array of parsed records. */
function readJsonl(path: string): any[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe("SetupLogger", () => {
  test("writes crash-proof JSONL entries (each line valid JSON)", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const logger = new SetupLogger(TEST_DIR);

    logger.log({
      timestamp: "2026-01-01T00:00:00Z",
      step: "test-step",
      command: "echo hello",
      exitCode: 0,
      stdout: "hello",
      duration_ms: 10,
    });

    logger.log({
      timestamp: "2026-01-01T00:00:01Z",
      step: "test-step-2",
      command: "ls",
      exitCode: 0,
      duration_ms: 5,
    });

    const logPath = logger.finalize();
    expect(existsSync(logPath)).toBe(true);

    const records = readJsonl(logPath);
    const execs = records.filter((r) => r.kind === "exec");
    expect(execs).toHaveLength(2);
    expect(execs[0].step).toBe("test-step");
    expect(execs[0].command).toBe("echo hello");
    expect(execs[1].step).toBe("test-step-2");

    // First record is setup-start meta entry.
    expect(records[0].event).toBe("setup-start");

    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("partial log is still readable line-by-line after a crash", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const logger = new SetupLogger(TEST_DIR);
    logger.setStep("deploy");
    logger.event("secrets-confirm-prompt");
    // Simulate a crash — no finalize() called.
    logger.crash(new Error("boom"), "test");

    const records = readJsonl(logger.getPath());
    const crash = records.find((r) => r.kind === "crash");
    expect(crash).toBeDefined();
    expect(crash.message).toBe("boom");
    expect(crash.step).toBe("deploy");

    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("redacts registered secrets and token-shaped strings", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const logger = new SetupLogger(TEST_DIR);
    logger.registerSecret("super-secret-value-123");

    logger.log({
      timestamp: "2026-01-01T00:00:00Z",
      step: "tokens",
      command: "gh auth token",
      exitCode: 0,
      stdout: "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 and super-secret-value-123",
      duration_ms: 1,
    });

    const raw = readFileSync(logger.getPath(), "utf-8");
    expect(raw).not.toContain("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");
    expect(raw).not.toContain("super-secret-value-123");
    expect(raw).toContain("«redacted-token»");
    expect(raw).toContain("«redacted-secret»");

    logger.finalize();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});
