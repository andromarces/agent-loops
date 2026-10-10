import { expect, test, vi } from "vite-plus/test";
import { cancelOnSigInt } from "../../src/lib/sigint.mjs";

// Usefulness: acceptance (#669) — the first SIGINT cancels the run and the process stays alive, so
// the run handler can set exit 130 and write its transcript; the listener stays registered.
test("the first SIGINT aborts the controller and keeps the listener", () => {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
  const before = process.listenerCount("SIGINT");
  const controller = new AbortController();
  const remove = cancelOnSigInt(controller);
  try {
    process.emit("SIGINT");
    expect(controller.signal.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
  } finally {
    remove();
    exit.mockRestore();
  }
  expect(process.listenerCount("SIGINT")).toBe(before);
});

// Usefulness: acceptance (#669) — a second SIGINT ends a stalled cleanup at once with exit 130, so
// the `on` listener does not trap the user in a run that ignores the cancel.
test("a second SIGINT ends the process with exit code 130", () => {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
  const remove = cancelOnSigInt(new AbortController());
  try {
    process.emit("SIGINT");
    process.emit("SIGINT");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  } finally {
    remove();
    exit.mockRestore();
  }
});
