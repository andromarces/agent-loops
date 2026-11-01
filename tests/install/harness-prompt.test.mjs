import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { expect, test } from "vite-plus/test";
import {
  askHarnessCheckboxes,
  checkboxSupported,
  harnessCheckboxItems,
} from "../../src/install/harness-prompt.mjs";

const SHOW_CURSOR = "\x1b[?25h";

class FakeInput extends EventEmitter {
  constructor({ isTTY = true, failRawMode = false } = {}) {
    super();
    this.isTTY = isTTY;
    this.rawMode = false;
    this.rawModeCalls = [];
    this.failRawMode = failRawMode;
    this.setRawMode = (value) => {
      this.rawModeCalls.push(value);
      if (this.failRawMode) {
        throw new Error("no raw mode");
      }
      this.rawMode = value;
    };
  }
}

class FakeOutput extends EventEmitter {
  constructor({ isTTY = true, columns, destroyed = undefined } = {}) {
    super();
    this.isTTY = isTTY;
    this.chunks = [];
    this.failWhen = null;
    if (columns !== undefined) {
      this.columns = columns;
    }
    if (destroyed !== undefined) {
      this.destroyed = destroyed;
    }
  }

  write(text) {
    if (this.failWhen?.(String(text), this.chunks.length)) {
      throw new Error("write failed");
    }
    this.chunks.push(String(text));
    return true;
  }

  get text() {
    return this.chunks.join("");
  }
}

function start(options) {
  const input = new FakeInput(options?.input);
  const output = new FakeOutput(options?.output);
  const pending = askHarnessCheckboxes({
    items: harnessCheckboxItems({
      checked: options?.checked ?? ["claude"],
      markDetected: options?.markDetected ?? true,
    }),
    input,
    output,
    env: options?.env ?? {},
  });
  return { input, output, pending };
}

function assertRestored(input, output) {
  expect(input.rawMode).toBe(false);
  expect(input.rawModeCalls.at(-1)).toBe(false);
  expect(output.text.endsWith(SHOW_CURSOR)).toBe(true);
  // The redraw is cleared before the cursor returns, so no menu stays behind.
  expect(output.chunks.at(-2)).toContain("\x1b[0J");
}

// Usefulness: acceptance #1319 — the list shows every harness once in HARNESS_ORDER.
// Each row carries its label, id, and detection marker.
// The checked set starts as the detected harnesses.
test("the checkbox list shows every harness in order with detection markers", async () => {
  const { input, output, pending } = start({ checked: ["claude", "opencode"] });
  const text = output.text;
  expect(text).toContain("> [x] Claude Code (claude) [detected]");
  expect(text).toContain("  [ ] Codex CLI (codex)\n");
  expect(text).toContain("  [x] OpenCode (opencode) [detected]");
  expect(text).toContain("  [ ] GitHub Copilot CLI (copilot)");
  expect(text).toContain("  [ ] Antigravity CLI (antigravity)");
  expect(text.indexOf("(claude)")).toBeLessThan(text.indexOf("(codex)"));
  expect(text.indexOf("(codex)")).toBeLessThan(text.indexOf("(opencode)"));
  expect(text.indexOf("(opencode)")).toBeLessThan(text.indexOf("(copilot)"));
  expect(text.indexOf("(copilot)")).toBeLessThan(text.indexOf("(antigravity)"));

  input.emit("keypress", "\r", { name: "return" });
  await expect(pending).resolves.toEqual({ supported: true, selected: ["claude", "opencode"] });
});

// Usefulness: acceptance #1319 — Space toggles only the highlighted item, Up and
// Down move the highlight, and both stay inside the list at its ends.
test("arrows move the highlight within the list and Space toggles only that item", async () => {
  const { input, pending } = start({ checked: ["claude"] });
  input.emit("keypress", "\x1b[B", { name: "down" });
  input.emit("keypress", " ", { name: "space" });
  for (let step = 0; step < 6; step += 1) {
    input.emit("keypress", "\x1b[B", { name: "down" });
  }
  input.emit("keypress", " ", { name: "space" });
  for (let step = 0; step < 6; step += 1) {
    input.emit("keypress", "\x1b[A", { name: "up" });
  }
  input.emit("keypress", " ", { name: "space" });
  input.emit("keypress", "\r", { name: "return" });
  await expect(pending).resolves.toEqual({
    supported: true,
    selected: ["codex", "antigravity"],
  });
});

// Usefulness: acceptance #1319 — Enter confirms on a carriage return and a line
// feed, and on both key names that Windows terminals report.
test.each([
  ["a carriage return named return", "\r", { name: "return" }],
  ["a line feed named return", "\n", { name: "return" }],
  ["a carriage return named enter", "\r", { name: "enter" }],
])("Enter confirms on %s", async (_name, sequence, key) => {
  const { input, pending } = start({ checked: ["codex"] });
  input.emit("keypress", sequence, key);
  await expect(pending).resolves.toEqual({ supported: true, selected: ["codex"] });
});

// Usefulness: acceptance #1319 — a confirmed empty set resolves no harness, the
// input that prints `No harness selected; nothing to do.`.
test("confirming with nothing checked resolves an empty selection", async () => {
  const { input, pending } = start({ checked: [] });
  input.emit("keypress", "\r", { name: "return" });
  await expect(pending).resolves.toEqual({ supported: true, selected: [] });
});

// Usefulness: acceptance #1319 — a typed name or number does not change the
// checkbox set, so only Space and the arrows drive the selection.
test("typed names and numbers are ignored by the checkbox list", async () => {
  const { input, pending } = start({ checked: ["claude"] });
  input.emit("keypress", "2", { name: "2" });
  input.emit("keypress", "codex", { name: "c" });
  input.emit("keypress", "\r", { name: "return" });
  await expect(pending).resolves.toEqual({ supported: true, selected: ["claude"] });
});

// Usefulness: acceptance #1319 and the README exit-code table — Ctrl+C cancels,
// reports its own reason, and restores raw mode, the cursor, and the redraw.
test("Ctrl+C cancels with the signal reason and restores the terminal", async () => {
  const { input, output, pending } = start();
  input.emit("keypress", "\x03", { name: "c", ctrl: true });
  await expect(pending).resolves.toEqual({
    supported: true,
    canceled: true,
    reason: "sigint",
  });
  assertRestored(input, output);
});

// Usefulness: acceptance #1319 — end of input cancels with its own reason and
// restores the terminal, so it never writes a file.
test("end of input cancels with the end reason and restores the terminal", async () => {
  const { input, output, pending } = start();
  input.emit("end");
  await expect(pending).resolves.toEqual({ supported: true, canceled: true, reason: "end" });
  assertRestored(input, output);
});

// Usefulness: acceptance #1319 — an asynchronous writable error must restore the terminal.
// The prompt drops every listener before it rejects with the same error.
// A failed stream cannot leave raw mode on.
test("an asynchronous output error rejects and restores the terminal", async () => {
  const { input, output, pending } = start();
  const failure = new Error("stream broke");
  output.emit("error", failure);
  await expect(pending).rejects.toBe(failure);
  expect(input.rawMode).toBe(false);
  expect(input.rawModeCalls.at(-1)).toBe(false);
  expect(input.listenerCount("keypress")).toBe(0);
  expect(output.chunks).toContain(SHOW_CURSOR);
  expect(output.chunks.at(-2)).toContain("\x1b[0J");
  expect(() => output.emit("error", new Error("late"))).not.toThrow();
});

// Usefulness: acceptance #1319 — an error that arrives after the prompt settled
// must not reach an unhandled `error` event, because the selection is final.
test("a late output error after confirming does not throw", async () => {
  const { input, output, pending } = start();
  input.emit("keypress", "\r", { name: "return" });
  await expect(pending).resolves.toEqual({ supported: true, selected: ["claude"] });
  expect(() => output.emit("error", new Error("late"))).not.toThrow();
  expect(() => output.emit("error", new Error("later"))).not.toThrow();
});

// Usefulness: acceptance #1319 — cleanup attempts the cursor show even when the
// stream reports itself destroyed, without throwing from the attempt.
test("cleanup attempts the cursor show on a destroyed stream", async () => {
  const { input, output, pending } = start({ output: { destroyed: true } });
  input.emit("keypress", "\r", { name: "return" });
  await expect(pending).resolves.toEqual({ supported: true, selected: ["claude"] });
  expect(output.chunks).toContain(SHOW_CURSOR);
  expect(input.rawMode).toBe(false);
  expect(input.listenerCount("keypress")).toBe(0);
});

// Usefulness: acceptance #1319 — a real Writable that emits an error restores the
// terminal and removes the keypress listener before the same error propagates.
test("a destroyed output stream restores the terminal", async () => {
  const input = new FakeInput();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  output.isTTY = true;
  output.columns = 80;
  const pending = askHarnessCheckboxes({
    items: harnessCheckboxItems({ checked: ["claude"] }),
    input,
    output,
    env: {},
  });
  const failure = new Error("stream broke");
  output.destroy(failure);
  await expect(pending).rejects.toBe(failure);
  expect(input.rawMode).toBe(false);
  expect(input.listenerCount("keypress")).toBe(0);
  expect(() => output.emit("error", new Error("late"))).not.toThrow();
});

// Usefulness: acceptance #1319 — the redraw counts wrapped terminal rows, so a
// narrow terminal clears the whole block and leaves no header behind.
test("the redraw counts wrapped rows at a narrow width", async () => {
  const { input, output, pending } = start({ checked: [], output: { columns: 20 } });
  const block = output.chunks[1].replace("\x1b[0J", "");
  const expectedRows = block
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / 20)), 0);
  expect(expectedRows).toBeGreaterThan(block.split("\n").length);
  input.emit("keypress", "\r", { name: "return" });
  await expect(pending).resolves.toEqual({ supported: true, selected: [] });
  expect(output.chunks.at(-2)).toContain(`\x1b[${expectedRows - 1}A`);
});

// Usefulness: acceptance #1319 — an error thrown inside a keypress handler
// rejects the prompt unchanged and still restores the terminal.
test("an error thrown inside a keypress handler rejects and restores the terminal", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let reads = 0;
  const items = [
    {
      id: "claude",
      get label() {
        reads += 1;
        if (reads > 1) {
          throw new Error("handler boom");
        }
        return "Claude Code";
      },
      checked: true,
      marker: " [detected]",
    },
  ];
  const pending = askHarnessCheckboxes({ items, input, output, env: {} });
  input.emit("keypress", " ", { name: "space" });
  await expect(pending).rejects.toThrow("handler boom");
  expect(input.rawMode).toBe(false);
  expect(output.text.endsWith(SHOW_CURSOR)).toBe(true);
});

// Usefulness: acceptance #1319 — a write error rejects the prompt and restores the terminal.
// Raw mode is off and the cursor returns, so a failed redraw cannot trap the user.
test("a write error rejects and restores the terminal", async () => {
  const { input, output, pending } = start();
  output.failWhen = (text) => text !== SHOW_CURSOR;
  input.emit("keypress", " ", { name: "space" });
  await expect(pending).rejects.toThrow("write failed");
  expect(input.rawMode).toBe(false);
  expect(output.chunks).toContain(SHOW_CURSOR);
});

// Usefulness: acceptance #1319 — the numbered prompt runs when the terminal cannot
// host the checkbox list. Each case resolves `supported: false` with no output and
// no raw mode, so the caller can fall back unchanged.
test.each([
  ["stdin is not a TTY", { input: { isTTY: false } }, true],
  ["stdout is not a TTY", { output: { isTTY: false } }, false],
  ["TERM is dumb", { env: { TERM: "dumb" } }, false],
  ["stdin has no setRawMode", { input: { noRawMode: true } }, true],
  ["setRawMode throws", { input: { failRawMode: true } }, true],
])("the checkbox list declines when %s", async (_name, options, rawModeUnavailable) => {
  const input = new FakeInput({
    isTTY: options.input?.isTTY ?? true,
    failRawMode: options.input?.failRawMode,
  });
  if (options.input?.noRawMode) {
    delete input.setRawMode;
  }
  const output = new FakeOutput({ isTTY: options.output?.isTTY ?? true });
  const result = await askHarnessCheckboxes({
    items: harnessCheckboxItems({ checked: ["claude"] }),
    input,
    output,
    env: options.env ?? {},
  });
  expect(result).toEqual({ supported: false, rawModeUnavailable });
  expect(output.chunks).toEqual([]);
  expect(input.rawMode).toBe(false);
});

// Usefulness: acceptance #1319 — the support check names every fallback
// condition, so the caller never opens a checkbox list it cannot drive.
test("checkboxSupported reports each fallback condition", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  expect(checkboxSupported({ input, output, env: {} })).toBe(true);
  expect(checkboxSupported({ input, output, env: { TERM: "dumb" } })).toBe(false);
  expect(checkboxSupported({ input, output: new FakeOutput({ isTTY: false }), env: {} })).toBe(
    false,
  );
  expect(checkboxSupported({ input: new FakeInput({ isTTY: false }), output, env: {} })).toBe(
    false,
  );
  expect(checkboxSupported({ input: new EventEmitter(), output, env: {} })).toBe(false);
});
