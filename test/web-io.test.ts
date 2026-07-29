import { describe, expect, test } from "bun:test";
import { WebIO, type WebEvent } from "../src/web/io.ts";
import { CANCEL } from "../src/wizard/io.ts";

/** Collect emitted events into an array for assertions. */
function harness(): { io: WebIO; events: WebEvent[] } {
  const events: WebEvent[] = [];
  const io = new WebIO((e) => events.push(e));
  return { io, events };
}

describe("WebIO reporter output", () => {
  test("maps reporter calls to SSE events and strips ANSI styling", () => {
    const { io, events } = harness();
    io.step("\u001b[1mStep 1 of 6: Preflight\u001b[22m");
    io.success("done");
    io.note("body", "Title");

    expect(events).toEqual([
      { type: "reporter", kind: "step", text: "Step 1 of 6: Preflight", title: undefined },
      { type: "reporter", kind: "success", text: "done", title: undefined },
      { type: "reporter", kind: "note", text: "body", title: "Title" },
    ]);
  });

  test("spinner emits start/message/stop with a stable id", () => {
    const { io, events } = harness();
    const s = io.spinner();
    s.start("working");
    s.stop("finished");
    const ids = events.map((e) => (e.type === "spinner" ? e.id : null));
    expect(ids[0]).toBe(ids[1]);
    expect(events).toEqual([
      { type: "spinner", id: ids[0]!, action: "start", text: "working" },
      { type: "spinner", id: ids[0]!, action: "stop", text: "finished" },
    ]);
  });
});

describe("WebIO prompts", () => {
  test("confirm resolves to a boolean once answered", async () => {
    const { io, events } = harness();
    const pending = io.confirm({ message: "Ready?", initialValue: true });
    const promptEvent = events.find((e) => e.type === "prompt");
    expect(promptEvent).toMatchObject({ promptType: "confirm", message: "Ready?" });

    const id = (promptEvent as Extract<WebEvent, { type: "prompt" }>).id;
    expect(io.hasPending(id)).toBe(true);
    io.answer(id, { value: false });
    expect(await pending).toBe(false);
    expect(io.hasPending(id)).toBe(false);
    // A prompt-resolved event follows so the client can clear the dock.
    expect(events.some((e) => e.type === "prompt-resolved" && e.id === id)).toBe(true);
  });

  test("select maps the chosen index back to the real option value", async () => {
    const { io, events } = harness();
    const pending = io.select({
      message: "Pick",
      options: [
        { value: "new", label: "New" },
        { value: "existing", label: "Existing" },
      ],
    });
    const id = (events.find((e) => e.type === "prompt") as Extract<WebEvent, { type: "prompt" }>).id;
    io.answer(id, { value: 1 });
    expect(await pending).toBe("existing");
  });

  test("text validation rejects bad input and keeps the prompt pending", async () => {
    const { io, events } = harness();
    const pending = io.text({
      message: "Repo",
      validate: (v) => (v && v.includes("/") ? undefined : "Must be owner/name"),
    });
    const id = (events.find((e) => e.type === "prompt") as Extract<WebEvent, { type: "prompt" }>).id;

    const bad = io.answer(id, { value: "nope" });
    expect(bad).toEqual({ ok: false, error: "Must be owner/name" });
    expect(io.hasPending(id)).toBe(true);

    const good = io.answer(id, { value: "acme/skills" });
    expect(good).toEqual({ ok: true });
    expect(await pending).toBe("acme/skills");
  });

  test("cancel resolves to the CANCEL sentinel", async () => {
    const { io, events } = harness();
    const pending = io.text({ message: "Name" });
    const id = (events.find((e) => e.type === "prompt") as Extract<WebEvent, { type: "prompt" }>).id;
    io.answer(id, { cancel: true });
    const result = await pending;
    expect(io.isCancel(result)).toBe(true);
    expect(result).toBe(CANCEL);
  });

  test("cancelAll resolves every outstanding prompt as cancelled", async () => {
    const { io, events } = harness();
    const a = io.text({ message: "A" });
    const b = io.confirm({ message: "B" });
    io.cancelAll();
    expect(io.isCancel(await a)).toBe(true);
    expect(io.isCancel(await b)).toBe(true);
    // Two prompt-resolved events, one per pending prompt.
    expect(events.filter((e) => e.type === "prompt-resolved").length).toBe(2);
  });

  test("answering an unknown prompt id is a safe error", () => {
    const { io } = harness();
    expect(io.answer("nope", { value: "x" })).toEqual({
      ok: false,
      error: "No such prompt (already answered?).",
    });
  });
});
