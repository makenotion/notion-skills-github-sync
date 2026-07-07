import { expect, test, describe } from "bun:test";
import { WizardLogger } from "../src/wizard/logger.ts";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-wizard-test");

describe("WizardLogger", () => {
  test("creates log file and writes entries", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const logger = new WizardLogger(TEST_DIR);

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

    const content = JSON.parse(readFileSync(logPath, "utf-8"));
    expect(content).toHaveLength(2);
    expect(content[0].step).toBe("test-step");
    expect(content[0].command).toBe("echo hello");
    expect(content[1].step).toBe("test-step-2");

    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("getEntries returns copies of logged entries", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const logger = new WizardLogger(TEST_DIR);

    logger.log({
      timestamp: "2026-01-01T00:00:00Z",
      step: "s1",
      command: "cmd1",
      exitCode: 0,
      duration_ms: 1,
    });

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].step).toBe("s1");

    logger.finalize();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});
