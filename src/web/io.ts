import {
  CANCEL,
  type WizardIO,
  type Spinner,
  type ConfirmOptions,
  type TextOptions,
  type PasswordOptions,
  type SelectOptions,
} from "../wizard/io.ts";

/**
 * The wire protocol between the local server and the browser. Every event is
 * JSON, streamed to the client over SSE. Reporter output, spinners, prompt
 * requests, and lifecycle transitions all flow through here — this is the web
 * analogue of the terminal's stdout.
 */
export type WebEvent =
  | { type: "reporter"; kind: ReporterKind; text: string; title?: string }
  | { type: "spinner"; id: string; action: "start" | "message" | "stop"; text: string }
  | {
      type: "prompt";
      id: string;
      promptType: "confirm" | "text" | "password" | "select";
      message: string;
      /** Default for a confirm prompt. */
      initialValue?: boolean;
      /** Prefilled value for a text prompt. */
      initialText?: string;
      initialIndex?: number;
      placeholder?: string;
      options?: Array<{ index: number; label: string; hint?: string }>;
    }
  | { type: "prompt-resolved"; id: string }
  | {
      type: "flow";
      status: "running" | "completed" | "cancelled" | "aborted";
      exitCode?: number;
      detail?: string;
    };

type ReporterKind =
  | "intro"
  | "outro"
  | "step"
  | "info"
  | "message"
  | "warn"
  | "error"
  | "success"
  | "note"
  | "cancel"
  | "handoff";

// The step copy is authored with picocolors styling; strip ANSI so the browser
// renders clean text (the terminal keeps its colors via ClackIO).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replace(ANSI, "");
}

interface PendingPrompt {
  kind: "confirm" | "text" | "password" | "select";
  validate?: (value: string | undefined) => string | undefined;
  /** Actual (server-side) option values for a select, indexed positionally. */
  optionValues?: unknown[];
  resolve: (value: unknown) => void;
}

/**
 * Web implementation of {@link WizardIO}. Reporter calls become SSE events;
 * each prompt call registers a pending promise the browser fulfills via
 * `POST /api/prompt/:id` (routed here through {@link answer}). Validation runs
 * server-side so the exact same rules as the CLI apply.
 */
export class WebIO implements WizardIO {
  private counter = 0;
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(private readonly send: (event: WebEvent) => void) {}

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private report(kind: ReporterKind, text: string, title?: string): void {
    this.send({ type: "reporter", kind, text: strip(text), title });
  }

  intro(message: string): void {
    this.report("intro", message);
  }
  outro(message: string): void {
    this.report("outro", message);
  }
  step(message: string): void {
    this.report("step", message);
  }
  info(message: string): void {
    this.report("info", message);
  }
  message(message: string): void {
    this.report("message", message);
  }
  warn(message: string): void {
    this.report("warn", message);
  }
  error(message: string): void {
    this.report("error", message);
  }
  success(message: string): void {
    this.report("success", message);
  }
  note(body: string, title?: string): void {
    this.report("note", body, title);
  }
  cancel(message: string): void {
    this.report("cancel", message);
  }
  handoff(prompt: string): void {
    this.report("handoff", prompt);
  }

  spinner(): Spinner {
    const id = this.nextId("spin");
    const send = this.send;
    return {
      start(msg = ""): void {
        send({ type: "spinner", id, action: "start", text: strip(msg) });
      },
      message(msg = ""): void {
        send({ type: "spinner", id, action: "message", text: strip(msg) });
      },
      stop(msg = ""): void {
        send({ type: "spinner", id, action: "stop", text: strip(msg) });
      },
    };
  }

  confirm(opts: ConfirmOptions): Promise<boolean | typeof CANCEL> {
    return this.request("confirm", {
      message: strip(opts.message),
      initialValue: opts.initialValue ?? false,
    }) as Promise<boolean | typeof CANCEL>;
  }

  text(opts: TextOptions): Promise<string | typeof CANCEL> {
    return this.request(
      "text",
      {
        message: strip(opts.message),
        placeholder: opts.placeholder,
        initialText: opts.initialValue,
      },
      { validate: opts.validate },
    ) as Promise<string | typeof CANCEL>;
  }

  password(opts: PasswordOptions): Promise<string | typeof CANCEL> {
    return this.request(
      "password",
      { message: strip(opts.message) },
      { validate: opts.validate },
    ) as Promise<string | typeof CANCEL>;
  }

  select<T>(opts: SelectOptions<T>): Promise<T | typeof CANCEL> {
    const options = opts.options.map((o, index) => ({
      index,
      label: strip(o.label),
      hint: o.hint ? strip(o.hint) : undefined,
    }));
    const initialIndex = opts.options.findIndex((o) => o.value === opts.initialValue);
    return this.request(
      "select",
      { message: strip(opts.message), options, initialIndex: initialIndex < 0 ? 0 : initialIndex },
      { optionValues: opts.options.map((o) => o.value) },
    ) as Promise<T | typeof CANCEL>;
  }

  isCancel(value: unknown): value is typeof CANCEL {
    return value === CANCEL;
  }

  private request(
    kind: PendingPrompt["kind"],
    payload: Omit<Extract<WebEvent, { type: "prompt" }>, "type" | "id" | "promptType">,
    extra?: {
      validate?: (value: string | undefined) => string | undefined;
      optionValues?: unknown[];
    },
  ): Promise<unknown> {
    const id = this.nextId("prompt");
    return new Promise((resolve) => {
      this.pending.set(id, {
        kind,
        validate: extra?.validate,
        optionValues: extra?.optionValues,
        resolve,
      });
      this.send({ type: "prompt", id, promptType: kind, ...payload });
    });
  }

  /** Whether a prompt with this id is currently awaiting an answer. */
  hasPending(id: string): boolean {
    return this.pending.has(id);
  }

  /**
   * Resolve a pending prompt from a client POST. Returns a validation error
   * (leaving the prompt pending) when the answer is rejected, mirroring the
   * CLI's live re-prompt behavior.
   */
  answer(
    id: string,
    raw: { value?: unknown; cancel?: boolean },
  ): { ok: true } | { ok: false; error: string } {
    const prompt = this.pending.get(id);
    if (!prompt) return { ok: false, error: "No such prompt (already answered?)." };

    if (raw.cancel) {
      this.resolve(id, prompt, CANCEL);
      return { ok: true };
    }

    let value: unknown;
    if (prompt.kind === "confirm") {
      value = Boolean(raw.value);
    } else if (prompt.kind === "select") {
      const idx = Number(raw.value);
      if (
        !Number.isInteger(idx) ||
        idx < 0 ||
        !prompt.optionValues ||
        idx >= prompt.optionValues.length
      ) {
        return { ok: false, error: "Invalid selection." };
      }
      value = prompt.optionValues[idx];
    } else {
      const str = raw.value == null ? "" : String(raw.value);
      if (prompt.validate) {
        const err = prompt.validate(str);
        if (err) return { ok: false, error: err };
      }
      value = str;
    }

    this.resolve(id, prompt, value);
    return { ok: true };
  }

  private resolve(id: string, prompt: PendingPrompt, value: unknown): void {
    this.pending.delete(id);
    this.send({ type: "prompt-resolved", id });
    prompt.resolve(value);
  }

  /** Cancel every outstanding prompt — used when the client gives up / disconnects. */
  cancelAll(): void {
    for (const [id, prompt] of this.pending) {
      this.send({ type: "prompt-resolved", id });
      prompt.resolve(CANCEL);
    }
    this.pending.clear();
  }
}
