import * as p from "@clack/prompts";
import { spinner as clackSpinner, type Spinner } from "./spinner.ts";

/**
 * The presentation seam between the wizard's step logic and however it's shown
 * to the user. The steps depend only on this interface — never on
 * `@clack/prompts` directly — so the exact same flow can be driven by the
 * terminal (`ClackIO`) or by the local web app (`WebIO`, see `web/io.ts`).
 *
 * It bundles two concerns the tech plan calls out separately:
 *   - a *Reporter* (step/info/warn/error/success/note + spinners), and
 *   - a *Prompt* surface (confirm/text/select/password).
 * They share one object because every step needs both, and threading a single
 * `io` keeps the call sites tidy.
 */

/** Sentinel returned by a prompt the user cancelled (Ctrl-C, closed tab, etc.). */
export const CANCEL: unique symbol = Symbol("wizard-cancel");

export type { Spinner };

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface ConfirmOptions {
  message: string;
  initialValue?: boolean;
}

export interface TextOptions {
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string | undefined) => string | undefined;
}

export interface PasswordOptions {
  message: string;
  validate?: (value: string | undefined) => string | undefined;
}

export interface SelectOptions<T> {
  message: string;
  initialValue?: T;
  options: SelectOption<T>[];
}

export interface WizardIO {
  // --- Reporter: status output ---
  intro(message: string): void;
  outro(message: string): void;
  /** A section header, e.g. "Step 3 of 6: ...". */
  step(message: string): void;
  info(message: string): void;
  /** A neutral, un-prefixed block of text. */
  message(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
  /** A boxed callout with an optional title (the plan summary, final recap). */
  note(body: string, title?: string): void;
  /** User cancelled — the flow is ending without finishing. */
  cancel(message: string): void;
  /** Render a ready-to-paste coding-agent handoff/eject prompt prominently. */
  handoff(prompt: string): void;

  // --- Prompt: input ---
  confirm(opts: ConfirmOptions): Promise<boolean | typeof CANCEL>;
  text(opts: TextOptions): Promise<string | typeof CANCEL>;
  password(opts: PasswordOptions): Promise<string | typeof CANCEL>;
  select<T>(opts: SelectOptions<T>): Promise<T | typeof CANCEL>;

  /** Whether a prompt result is the cancel sentinel. */
  isCancel(value: unknown): value is typeof CANCEL;

  /** A progress spinner. `start`/`message`/`stop` mirror the CLI shim. */
  spinner(): Spinner;
}

/**
 * Terminal implementation: a thin adapter over `@clack/prompts` and the
 * stdin-safe spinner shim. Behavior is intentionally identical to the wizard's
 * previous direct clack usage — this class only moves those calls behind the
 * interface so the web app can supply its own implementation.
 */
export class ClackIO implements WizardIO {
  intro(message: string): void {
    p.intro(message);
  }
  outro(message: string): void {
    p.outro(message);
  }
  step(message: string): void {
    p.log.step(message);
  }
  info(message: string): void {
    p.log.info(message);
  }
  message(message: string): void {
    p.log.message(message);
  }
  warn(message: string): void {
    p.log.warn(message);
  }
  error(message: string): void {
    p.log.error(message);
  }
  success(message: string): void {
    p.log.success(message);
  }
  note(body: string, title?: string): void {
    p.note(body, title);
  }
  cancel(message: string): void {
    p.cancel(message);
  }
  handoff(prompt: string): void {
    // Plain console.log, outside clack's gutter, so it copies cleanly.
    console.log("\n" + prompt + "\n");
  }

  async confirm(opts: ConfirmOptions): Promise<boolean | typeof CANCEL> {
    const v = await p.confirm(opts);
    return p.isCancel(v) ? CANCEL : v;
  }
  async text(opts: TextOptions): Promise<string | typeof CANCEL> {
    const v = await p.text(opts);
    return p.isCancel(v) ? CANCEL : String(v);
  }
  async password(opts: PasswordOptions): Promise<string | typeof CANCEL> {
    const v = await p.password(opts);
    return p.isCancel(v) ? CANCEL : String(v);
  }
  async select<T>(opts: SelectOptions<T>): Promise<T | typeof CANCEL> {
    const v = await p.select(opts as never);
    return p.isCancel(v) ? CANCEL : (v as T);
  }

  isCancel(value: unknown): value is typeof CANCEL {
    return value === CANCEL;
  }

  spinner(): Spinner {
    return clackSpinner();
  }
}
