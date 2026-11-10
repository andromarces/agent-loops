import { expect, test } from "vite-plus/test";
import { readTopLevel, SnapshotError, withGitIdentityReads } from "../../src/lib/git-read.mjs";

// Usefulness: the top-level read keeps a trailing space and a carriage return — no real-path case runs on Windows.
test("readTopLevel keeps a trailing space and a carriage return", async () => {
  const options = [];
  const read = async (cwd, args, readOptions) => {
    options.push(readOptions);
    return { exitCode: 0, stdout: "/work/repo \r\n", stderr: "" };
  };

  const result = await readTopLevel("/work", { read, timeoutMs: 1 });

  expect(result.stdout).toBe("/work/repo \r");
  expect(options).toEqual([{ timeoutMs: 1, stripFinalNewline: false }]);
});

// Usefulness: verifies a canceled identity read is not shared, so a later caller runs its own read.
test("a canceled identity read is not shared with a later caller", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const read = async () => {
    const call = ++calls;
    if (call === 1) {
      await gate;
      throw new SnapshotError("git rev-parse was canceled", { isCanceled: true });
    }
    return { exitCode: 0, stdout: "/work/repo\n", stderr: "" };
  };

  await withGitIdentityReads(async () => {
    const first = readTopLevel("/work", { read });
    const second = readTopLevel("/work", { read });
    release();
    await expect(first).rejects.toMatchObject({ isCanceled: true });
    await expect(second).resolves.toMatchObject({ stdout: "/work/repo" });
  });
  expect(calls).toBe(2);
});
