import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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

export class WizardLogger {
  private logPath: string;
  private entries: LogEntry[] = [];

  constructor(logDir?: string) {
    const dir = logDir || join(process.cwd(), ".notion-sync-setup");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.logPath = join(dir, `setup-${ts}.log.json`);
    writeFileSync(this.logPath, "[\n", "utf-8");
  }

  log(entry: LogEntry): void {
    this.entries.push(entry);
    const prefix = this.entries.length > 1 ? ",\n" : "";
    appendFileSync(this.logPath, prefix + JSON.stringify(entry, null, 2), "utf-8");
  }

  finalize(): string {
    appendFileSync(this.logPath, "\n]\n", "utf-8");
    return this.logPath;
  }

  getPath(): string {
    return this.logPath;
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }
}
