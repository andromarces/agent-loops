import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { pidAlive } from "../src/lib/runstate.mjs";
import { cleanRepoGit, deadPid, untrackedFilesGit } from "./runtime-helpers.mjs";

const options = { cwd: tmpdir() };
const expected = ["rev-parse", "--verify", "-q", "HEAD"];
const merged = ["rev-parse", "--verify -q", "HEAD"];

// Usefulness: acceptance (#514) — a merged-argument call reads differently from the expected call in the error.
test("cleanRepoGit error for a merged-argument call differs from the expected call text", () => {
  const message = (args) => {
    try {
      cleanRepoGit("git", args, options);
    } catch (error) {
      return error.message;
    }
    return undefined;
  };
  expect(message(expected)).toBeUndefined();
  expect(message(merged)).toBeDefined();
  expect(message(merged)).not.toBe(`unexpected git call: ${expected.join(" ")}`);
});

// Usefulness: acceptance (#514) — the same holds for `untrackedFilesGit`, which delegates unknown calls.
test("untrackedFilesGit error for a merged-argument call differs from the expected call text", async () => {
  const error = await untrackedFilesGit("git", merged, options).catch((caught) => caught);
  expect(error.message).toContain("unexpected git call");
  expect(error.message).not.toBe(`unexpected git call: ${expected.join(" ")}`);
});

// Usefulness: acceptance (#546) — the dead owner reads as dead and is never a pid of a running process, so a test cannot fail on pid reuse.
test("deadPid is a valid pid that the production liveness check reads as dead", async () => {
  const pid = await deadPid();
  expect(pid).not.toBe(process.pid);
  expect(pidAlive(pid)).toBe(false);
});
