import { expect, test } from "vite-plus/test";
import {
  readBranch,
  readHeadBranch,
  readTopLevel,
  SnapshotError,
  stripLf,
  withGitIdentityReads,
} from "../../src/lib/git-read.mjs";

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

// Usefulness: verifies the shared branch read hands the caller options to the reader and returns its detached result (#1889).
test("readBranch passes the caller options and returns its detached result", async () => {
  const calls = [];
  const git = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    return { exitCode: 1, stdout: "", stderr: "" };
  };

  const branch = await readBranch(git, "/work", {
    detached: null,
    allowExit: [0, 1],
    env: { GIT_OPTIONAL_LOCKS: "0" },
    stripFinalNewline: false,
    strip: stripLf,
  });

  expect(branch).toBeNull();
  expect(calls).toEqual([
    {
      cwd: "/work",
      args: ["symbolic-ref", "--short", "-q", "HEAD"],
      options: {
        allowExit: [0, 1],
        env: { GIT_OPTIONAL_LOCKS: "0" },
        stripFinalNewline: false,
      },
    },
  ]);
});

// Usefulness: verifies the shared branch read keeps the readHeadBranch trim and empty detached result (#1889).
test("readHeadBranch trims the name and returns an empty string for a detached head", async () => {
  let call = 0;
  const git = async () => {
    call += 1;
    return { exitCode: call === 1 ? 0 : 1, stdout: " main \n", stderr: "" };
  };

  await expect(readHeadBranch(git, "/work")).resolves.toBe("main");
  await expect(readHeadBranch(git, "/work")).resolves.toBe("");
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
