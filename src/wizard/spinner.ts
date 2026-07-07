import pc from "picocolors";

/**
 * A minimal, stdin-safe spinner — a drop-in for `@clack/prompts`' `spinner()`.
 *
 * Why not use clack's? Its spinner calls `@clack/core`'s `block()` to swallow
 * input while spinning, and `block()`:
 *   - hard-exits the process (`process.exit(0)`) on an escape / empty-name key
 *     (both are aliased to "cancel" by default), and
 *   - can leak its keypress listener onto stdin past `spinner.stop()`.
 * The result was a silent `exit(0)` with no error when a stray escape-like byte
 * arrived during a later prompt (see the setup logs). This shim renders the
 * same kind of status line but NEVER touches stdin, raw mode, or keypresses, so
 * that entire failure mode is impossible.
 *
 * Only `.start()` / `.stop()` / `.message()` are used by the wizard.
 */
const FRAMES = ["◐", "◓", "◑", "◒"];

export interface Spinner {
  start(message?: string): void;
  message(message?: string): void;
  stop(message?: string): void;
}

export function spinner(): Spinner {
  let interval: ReturnType<typeof setInterval> | null = null;
  let message = "";
  let frame = 0;
  const isTTY = Boolean(process.stdout.isTTY);

  const clearLine = () => {
    if (isTTY) process.stdout.write("\r\x1b[K");
  };

  const render = () => {
    if (!isTTY) return;
    clearLine();
    process.stdout.write(`${pc.magenta(FRAMES[frame])}  ${message}`);
    frame = (frame + 1) % FRAMES.length;
  };

  return {
    start(msg = "") {
      message = msg;
      if (isTTY) {
        process.stdout.write("\n");
        render();
        // setInterval keeps the loop alive only until stop() clears it, and it
        // never reads stdin — so it can't interfere with the next prompt.
        interval = setInterval(render, 120);
      } else {
        process.stdout.write(`•  ${message}\n`);
      }
    },
    message(msg = "") {
      message = msg;
    },
    stop(msg = "") {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      const final = msg || message;
      if (isTTY) {
        clearLine();
        process.stdout.write(`${pc.green("◇")}  ${final}\n`);
      } else {
        process.stdout.write(`◇  ${final}\n`);
      }
    },
  };
}
