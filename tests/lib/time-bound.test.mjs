import { execFileSync } from "node:child_process";
import { expect, test } from "vite-plus/test";
import { withTimeBound } from "../../src/lib/time-bound.mjs";

// Usefulness: verifies requirement "the bound ends a wait on a call that cannot be canceled with
// the named error, and aborts the signal the call took" (#1269); no other test covers the helper.
test("a call that outlasts the bound is aborted and its wait rejects with the named error", async () => {
  let seen;
  const error = await withTimeBound(20, "read took over 20 ms", ({ signal, stopped }) => {
    seen = signal;
    return Promise.race([new Promise(() => {}), stopped]);
  }).catch((err) => err);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe("read took over 20 ms");
  expect(seen.aborted).toBe(true);
  expect(seen.reason).toBe(error);
});

// Usefulness: verifies a call inside the bound returns its value and leaves the signal unaborted.
test("a call inside the bound returns its value with no abort", async () => {
  let seen;
  const value = await withTimeBound(5_000, "late", async ({ signal }) => {
    seen = signal;
    return 7;
  });
  expect(value).toBe(7);
  expect(seen.aborted).toBe(false);
});

// Usefulness: verifies requirement "a pending read never keeps the process alive": the timer is
// unref'd, and it is cleared when the call settles, so a later abort never fires.
test("a long bound keeps no process alive, whether the call is pending or settled", () => {
  const script = `
    const { withTimeBound } = await import(${JSON.stringify(new URL("../../src/lib/time-bound.mjs", import.meta.url).href)});
    await withTimeBound(60_000, "x", async () => 1);
    withTimeBound(60_000, "x", () => new Promise(() => {})).catch(() => {});
  `;
  const started = Date.now();
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 20_000 });
  expect(Date.now() - started).toBeLessThan(15_000);
});
