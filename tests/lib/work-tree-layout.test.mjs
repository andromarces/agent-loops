import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { mainWorkTreePath } from "../../src/lib/work-tree-layout.mjs";

const roots = [];

afterEach(async () => {
  execa.mockReset();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

// Usefulness: verifies a failed work tree list keeps the origin `local files` error text.
// Not redundant: no other test asserts the layout module error text.
test("a failed work tree list keeps the local files error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "layout-test-"));
  roots.push(root);
  execa.mockImplementation(async (_command, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { exitCode: 0, stdout: `${root}\n`, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return { exitCode: 128, stdout: "", stderr: "fatal: simulated failure" };
    }
    throw new Error(`unexpected git call: ${JSON.stringify(args)}`);
  });

  await expect(mainWorkTreePath(root)).rejects.toThrow(
    "local files: git worktree failed (exit 128): fatal: simulated failure",
  );
});
