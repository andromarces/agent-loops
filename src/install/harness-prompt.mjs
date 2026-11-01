// Interactive checkbox prompt for the install and uninstall harness selection
// (#1319). It drives `node:readline` keypress events in raw mode.
// It adds no dependency because Node supplies the keypress events.
// The caller runs the numbered prompt when the terminal cannot host the list.
import { emitKeypressEvents } from "node:readline";
import { HARNESS_META, HARNESS_ORDER } from "../lib/harnesses.mjs";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HEADER = "Select harnesses: Up/Down move, Space toggles, Enter confirms.";
const LATE_ERROR_GUARD = Symbol.for("agent-loop.late-output-error");

// A stream that stays open after the prompt can emit an error with no reader.
// Node turns that event into an uncaught exception, so keep one inert listener
// on the stream once its prompt has settled.
function guardLateOutputError(output) {
  if (!output?.on || output[LATE_ERROR_GUARD]) {
    return;
  }
  output[LATE_ERROR_GUARD] = true;
  output.on("error", () => {});
}

/**
 * Builds the checkbox rows in HARNESS_ORDER. `markDetected` labels the checked
 * harnesses as detected, which only the install prompt does.
 */
export function harnessCheckboxItems({
  harnesses = HARNESS_ORDER,
  checked = [],
  markDetected = false,
} = {}) {
  return harnesses.map((id) => ({
    id,
    label: HARNESS_META[id].label,
    checked: checked.includes(id),
    marker: markDetected && checked.includes(id) ? " [detected]" : "",
  }));
}

/** True when the streams and terminal support the raw-mode checkbox list. */
export function checkboxSupported({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
} = {}) {
  return Boolean(
    input?.isTTY && output?.isTTY && env?.TERM !== "dumb" && typeof input.setRawMode === "function",
  );
}

/** Rows that a block of lines occupies on a terminal of `columns` columns. */
function wrappedRows(lines, columns) {
  if (!(Number.isInteger(columns) && columns > 0)) {
    return lines.length;
  }
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0);
}

/** True when the input TTY accepts raw mode now. Leaves raw mode off again. */
function canEnterRawMode(input) {
  if (!input?.isTTY || typeof input.setRawMode !== "function") {
    return false;
  }
  try {
    input.setRawMode(true);
    input.setRawMode(false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Renders the checkbox list and resolves one of three outcomes. `supported:
 * false` means the caller must run the numbered prompt. A cancelled prompt
 * (Ctrl+C or end of input) resolves no selection. Side effect: enables raw
 * mode and hides the cursor, and restores both before it settles.
 */
export async function askHarnessCheckboxes({
  items,
  input = process.stdin,
  output = process.stdout,
  env = process.env,
} = {}) {
  const rawMode = canEnterRawMode(input);
  if (!checkboxSupported({ input, output, env }) || !rawMode) {
    return { supported: false, rawModeUnavailable: !rawMode };
  }
  try {
    input.setRawMode(true);
  } catch {
    return { supported: false, rawModeUnavailable: true };
  }

  const checked = items.map((item) => Boolean(item.checked));
  let cursor = 0;
  let drawnRows = 0;

  try {
    emitKeypressEvents(input);
  } catch (err) {
    try {
      input.setRawMode(false);
    } catch {
      // The original failure is the one to report.
    }
    throw err;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;

    const detach = () => {
      input.off?.("keypress", onKeypress);
      input.off?.("end", onEnd);
      input.off?.("close", onEnd);
      output.off?.("error", onOutputError);
      guardLateOutputError(output);
    };

    const clear = () => {
      if (drawnRows === 0) {
        return;
      }
      output.write(`\x1b[${drawnRows - 1}A\r\x1b[0J`);
      drawnRows = 0;
    };

    const render = () => {
      const lines = [
        HEADER,
        ...items.map(
          (item, index) =>
            `${index === cursor ? ">" : " "} [${checked[index] ? "x" : " "}] ` +
            `${item.label} (${item.id})${item.marker ?? ""}`,
        ),
      ];
      if (drawnRows > 0) {
        output.write(`\x1b[${drawnRows - 1}A\r`);
      }
      output.write(`\x1b[0J${lines.join("\n")}`);
      drawnRows = wrappedRows(lines, output.columns);
    };

    // Leaves raw mode and pauses the input first, so a failed cursor write
    // cannot skip them. Each cleanup step is attempted, and the first failure
    // still reaches the caller.
    const restore = () => {
      let failure = null;
      try {
        input.setRawMode(false);
      } catch (err) {
        failure = err;
      }
      try {
        input.pause?.();
      } catch (err) {
        failure ??= err;
      }
      try {
        clear();
      } catch (err) {
        failure ??= err;
      }
      try {
        output.write(SHOW_CURSOR);
      } catch (err) {
        failure ??= err;
      }
      return failure;
    };

    const settle = (value, error) => {
      if (settled) {
        return;
      }
      settled = true;
      const restoreError = restore();
      detach();
      if (error) {
        reject(error);
      } else if (restoreError) {
        reject(restoreError);
      } else {
        resolve(value);
      }
    };

    const onOutputError = (error) => settle(null, error);

    const onKeypress = (sequence, key) => {
      if (settled) {
        return;
      }
      try {
        const name = key?.name ?? "";
        if ((key?.ctrl && name === "c") || sequence === "\x03") {
          return settle({ supported: true, canceled: true, reason: "sigint" });
        }
        if ((key?.ctrl && name === "d") || sequence === "\x04") {
          return settle({ supported: true, canceled: true, reason: "end" });
        }
        if (name === "return" || name === "enter" || sequence === "\r" || sequence === "\n") {
          return settle({
            supported: true,
            selected: items.filter((item, index) => checked[index]).map((item) => item.id),
          });
        }
        if (name === "space" || sequence === " ") {
          checked[cursor] = !checked[cursor];
          return render();
        }
        if (name === "up") {
          cursor = Math.max(0, cursor - 1);
          return render();
        }
        if (name === "down") {
          cursor = Math.min(items.length - 1, cursor + 1);
          return render();
        }
      } catch (err) {
        settle(null, err);
      }
    };

    const onEnd = () => settle({ supported: true, canceled: true, reason: "end" });

    input.on("keypress", onKeypress);
    input.on("end", onEnd);
    input.on("close", onEnd);
    output.on?.("error", onOutputError);

    try {
      output.write(HIDE_CURSOR);
      render();
    } catch (err) {
      settle(null, err);
    }
  });
}
