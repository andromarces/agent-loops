import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { processExists, removePath } from "../runtime-helpers.mjs";

// `helperArgs` replaces the arguments of the removal helper, so the test runs a helper that hangs
// or dies instead of the real one.
const hook = vi.hoisted(() => ({ helperArgs: null }));

vi.mock("../../src/lib/exec.mjs", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    execBounded: (command, args, options) =>
      actual.execBounded(command, hook.helperArgs ?? args, options),
  };
});

const { withTurnTmpdir } = await import("../../src/lib/turn-tmpdir.mjs");

const BOUND_MS = 400;
// The bound, the forced end after a refused SIGTERM, and slack for a loaded machine.
const MAX_WAIT_MS = BOUND_MS + 1000 + 4000;

let dir;
let warnings;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "turn-tmpdir-bound-"));
  warnings = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  hook.helperArgs = null;
  warnings.mockRestore();
  await removePath(dir);
});

// A helper that ignores SIGTERM and records its pid, as the instrumented helper of the review did.
function hangingHelper() {
  const script = join(dir, "hang.mjs");
  const pidFile = join(dir, "hang.pid");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`,
  );
  hook.helperArgs = [script];
  return pidFile;
}

const warned = () => warnings.mock.calls.some(([line]) => String(line).includes("not removed"));

// Usefulness: verifies a helper that ignores SIGTERM ends at the bound by force, the turn result
// survives, and the turn waits no longer than the bound plus the forced end.
test("a hanging removal helper ends at the bound and never fails the turn", async () => {
  const pidFile = hangingHelper();
  const started = Date.now();
  const result = await withTurnTmpdir(async () => "turn result", { removalBoundMs: BOUND_MS });
  expect(result).toBe("turn result");
  expect(Date.now() - started).toBeLessThan(MAX_WAIT_MS);
  expect(processExists(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  expect(warned()).toBe(true);
});

// Usefulness: verifies a canceled or timed-out turn does not wait past the bound for the helper
// and still reports its own error.
test("a failed turn does not wait past the bound for a hanging helper", async () => {
  const pidFile = hangingHelper();
  const started = Date.now();
  const failure = Object.assign(new Error("canceled"), { isCanceled: true });
  await expect(
    withTurnTmpdir(
      async () => {
        throw failure;
      },
      { removalBoundMs: BOUND_MS },
    ),
  ).rejects.toBe(failure);
  expect(Date.now() - started).toBeLessThan(MAX_WAIT_MS);
  expect(processExists(Number(readFileSync(pidFile, "utf8")))).toBe(false);
});

// Usefulness: verifies a helper that is killed from outside only warns.
test("a killed removal helper only warns", async () => {
  const script = join(dir, "die.mjs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(script, 'process.kill(process.pid, "SIGKILL");\nsetInterval(() => {}, 1000);');
  hook.helperArgs = [script];
  await expect(withTurnTmpdir(async () => "turn result")).resolves.toBe("turn result");
  expect(warned()).toBe(true);
});
