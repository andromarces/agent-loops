import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
import { resolveWorkerPr } from "../../src/lib/worker-pr.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";

// The order in which the run state `git` reads start and end. `slowBranch` delays the end of the
// branch read, as a slow disk does.
const reads = vi.hoisted(() => ({ events: [], slowBranch: false }));
vi.mock("../../src/lib/exec.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execBounded: async (command, args, ...rest) => {
      if (command !== "git") return real.execBounded(command, args, ...rest);
      if (args[0] === "rev-parse") reads.events.push("head read started");
      const result = await real.execBounded(command, args, ...rest);
      if (args[0] === "symbolic-ref" && reads.slowBranch) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        reads.events.push("branch read ended");
      }
      return result;
    },
  };
});

let repo;
let head;
beforeEach(async () => {
  repo = await createTempRepo();
  await execa("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], {
    cwd: repo,
  });
  head = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
});
afterEach(async () => {
  reads.slowBranch = false;
  await removePath(repo);
});

// Usefulness: verifies the work tree head read starts without waiting for the branch, remote, and
// URL reads (issue #1187), since it does not depend on them; the resolution is unchanged.
test("the PR resolution reads the work tree head while the branch read runs", async () => {
  reads.events.length = 0;
  reads.slowBranch = true;
  const gh = vi.fn(async () => ({ status: 0, stdout: "[]", stderr: "" }));
  const result = await resolveWorkerPr({ cwd: repo, head, gh });
  expect(reads.events.indexOf("head read started")).toBeGreaterThanOrEqual(0);
  expect(reads.events.indexOf("head read started")).toBeLessThan(
    reads.events.indexOf("branch read ended"),
  );
  expect(result).toMatchObject({ pr: null, quiet: true });
});
