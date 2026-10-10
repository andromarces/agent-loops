import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { killTreeOnExit } from "../../src/lib/exec-tree.mjs";
import { removePath } from "../runtime-helpers.mjs";
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

// Usefulness: acceptance (#669) — the second SIGINT force-kills a live child that ignores SIGTERM,
// runs the final write before the exit, and ends with exit 130, so no child outlives the run. A
// failed final write still ends the process.
test.each([
  ["a final write that succeeds", () => {}],
  [
    "a final write that throws",
    () => {
      throw new Error("disk full");
    },
  ],
])(
  "the second SIGINT kills a SIGTERM-resistant child, writes, and exits 130 (%s)",
  async (_, write) => {
    const dir = await mkdtemp(join(tmpdir(), "sigint-force-"));
    const pidFile = join(dir, "child.pid");
    const script =
      'require("fs").writeFileSync(process.argv[1], String(process.pid));' +
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const subprocess = killTreeOnExit(
      execa(process.execPath, ["-e", script, pidFile], {
        reject: false,
        cleanup: true,
        killDescendants: true,
      }),
    );
    const order = [];
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => order.push(`exit ${code}`));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const remove = cancelOnSigInt(new AbortController(), {
      onForceExit: () => {
        order.push("write");
        write();
      },
    });
    let pid;
    try {
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
          expect(pid).toBeGreaterThan(0);
        },
        { timeout: 20_000, interval: 100 },
      );
      process.emit("SIGINT");
      process.emit("SIGINT");
      expect(order).toEqual(["write", "exit 130"]);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
        timeout: 5000,
        interval: 100,
      });
    } finally {
      remove();
      exit.mockRestore();
      errorSpy.mockRestore();
      await subprocess;
      await removePath(dir);
    }
  },
  40_000,
);
