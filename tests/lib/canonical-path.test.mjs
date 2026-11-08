import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { canonicalPath } from "../../src/lib/canonical-path.mjs";

// Usefulness: requirement — a path that resolves keeps the spelling that realpath returns, which
// the work tree lock and the session record compare. Not redundant: no existing test calls it.
test("returns the real path when realpath succeeds", async () => {
  const path = resolve(".");
  expect(await canonicalPath(path)).toBe(await realpath(path));
});

// Usefulness: requirement — a path that cannot resolve, such as a missing one, falls back to its
// resolved form instead of throwing, so the callers keep their previous behavior.
test("falls back to the resolved path when realpath fails", async () => {
  const missing = join(tmpdir(), `agent-loops-canonical-path-${randomUUID()}`);
  expect(await canonicalPath(missing)).toBe(resolve(missing));
});
