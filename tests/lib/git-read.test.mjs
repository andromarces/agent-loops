import { expect, test } from "vite-plus/test";
import { readTopLevel } from "../../src/lib/git-read.mjs";

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
