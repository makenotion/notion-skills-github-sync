import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface LogEntry {
  timestamp: string;
  step: string;
  command: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  duration_ms: number;
  diagnostics?: string;
}

/**
 * Structured, crash-proof setup logger.
 *
 * Design goals (learned the hard way — a crash in the secrets step left an
 * unparseable, reason-less log):
 *  - **JSONL, not a JSON array.** One self-contained JSON object per line, so a
 *    log truncated by a crash is still fully readable up to the last flushed
 *    line. No trailing `]` to depend on.
 *  - **Crash capture.** Global `uncaughtException` / `unhandledRejection`
 *    handlers write a final `crash` record (with stack + the step that was
 *    active) before the process dies. Also flushes on `exit`.
 *  - **Secret redaction.** Tokens are scrubbed from everything written to disk,
 *    both via an explicit registry and via known token-shape regexes.
 */
export class WizardLogger {
  private logPath: string;
  private entries: unknown[] = [];
  private secrets: string[] = [];
  private currentStep = "init";
  private handlersInstalled = false;

  // Known token shapes, redacted even if never explicitly registered.
  private static readonly TOKEN_PATTERNS: RegExp[] = [
    /gh[posru]_[A-Za-z0-9]{20,}/g, // gho_/ghp_/ghs_/ghr_/ghu_
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /(?:development_ntn_|ntn_|secret_)[A-Za-z0-9]{20,}/g,
  ];

  constructor(logDir?: string) {
    const dir = logDir || join(process.cwd(), ".notion-sync-setup");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.logPath = join(dir, `setup-${ts}.log.jsonl`);
    writeFileSync(this.logPath, "", "utf-8");
    this.installCrashHandlers();
    this.write({
      kind: "meta",
      timestamp: new Date().toISOString(),
      event: "wizard-start",
      cwd: process.cwd(),
      platform: process.platform,
      node: process.version,
      bun: (process.versions as Record<string, string>).bun ?? null,
      argv: process.argv.slice(2),
      tty: Boolean(process.stdout.isTTY),
    });
  }

  /** Register a secret value so it's scrubbed from all future writes. */
  registerSecret(value?: string | null): void {
    if (value && value.trim().length >= 8) {
      const v = value.trim();
      if (!this.secrets.includes(v)) this.secrets.push(v);
    }
  }

  private redact(value: unknown): unknown {
    if (typeof value === "string") {
      let out = value;
      for (const secret of this.secrets) {
        if (secret) out = out.split(secret).join("«redacted-secret»");
      }
      for (const re of WizardLogger.TOKEN_PATTERNS) {
        out = out.replace(re, "«redacted-token»");
      }
      return out;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.redact(v));
    }
    if (value && typeof value === "object") {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) obj[k] = this.redact(v);
      return obj;
    }
    return value;
  }

  private write(obj: Record<string, unknown>): void {
    const redacted = this.redact(obj) as Record<string, unknown>;
    this.entries.push(redacted);
    try {
      appendFileSync(this.logPath, JSON.stringify(redacted) + "\n", "utf-8");
    } catch {
      // Never let logging itself crash the wizard.
    }
  }

  /** Mark the start of a step; subsequent events/execs are attributed to it. */
  setStep(step: string): void {
    this.currentStep = step;
    this.event("step-enter", { step });
  }

  /** Record a structured, non-exec event (prompt result, branch, note). */
  event(event: string, data?: Record<string, unknown>): void {
    this.write({
      kind: "event",
      timestamp: new Date().toISOString(),
      step: this.currentStep,
      event,
      ...(data ?? {}),
    });
  }

  /** Record the outcome of an exec (redacted). */
  log(entry: LogEntry): void {
    if (entry.step) this.currentStep = entry.step;
    this.write({ kind: "exec", ...entry });
  }

  /** Record a fatal crash with as much context as we can capture. */
  crash(err: unknown, source: string): void {
    const e = err instanceof Error ? err : undefined;
    this.write({
      kind: "crash",
      timestamp: new Date().toISOString(),
      step: this.currentStep,
      source,
      message: e ? e.message : String(err),
      name: e?.name ?? null,
      stack: e?.stack ?? null,
    });
  }

  private installCrashHandlers(): void {
    if (this.handlersInstalled) return;
    this.handlersInstalled = true;
    // Handling these events stops Node from auto-crashing, so we must exit
    // explicitly — otherwise the wizard could hang after an out-of-band error.
    process.on("uncaughtException", (err) => {
      this.crash(err, "uncaughtException");
      process.stderr.write(`\n✖ Setup crashed. Diagnostic log: ${this.logPath}\n`);
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      this.crash(reason, "unhandledRejection");
      process.stderr.write(`\n✖ Setup crashed. Diagnostic log: ${this.logPath}\n`);
      process.exit(1);
    });
    process.on("exit", (code) => {
      this.write({
        kind: "meta",
        timestamp: new Date().toISOString(),
        event: "process-exit",
        step: this.currentStep,
        code,
      });
    });
  }

  finalize(): string {
    this.write({
      kind: "meta",
      timestamp: new Date().toISOString(),
      event: "wizard-finalize",
      step: this.currentStep,
    });
    return this.logPath;
  }

  getPath(): string {
    return this.logPath;
  }

  getEntries(): unknown[] {
    return [...this.entries];
  }
}
