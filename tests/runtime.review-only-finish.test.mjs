import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { runLoop } from "../src/runtime.mjs";
import { removePath, scripted } from "./runtime-helpers.mjs";

const HEAD = "1111111111111111111111111111111111111111";

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await removePath(dir);
  }
});

// A clean repo at one commit, answered from memory. The real snapshot code still
// runs over these answers, so a turn that changed the repo is still detected by
// the difference between two snapshots; only the `git` processes are gone.
function cleanRepoGit(cwd) {
  return async (command, args) => {
    expect(command).toBe("git");
    const answer = (stdout) => ({ exitCode: 0, stdout, stderr: "" });
    switch (args[0]) {
      case "rev-parse":
        if (args.includes("--git-common-dir")) {
          // The directory holds a `.git` directory, so it is its own main work tree.
          return answer(".git\n");
        }
        return answer(args.includes("--show-toplevel") ? cwd : `${HEAD}\n`);
      // No `core.worktree` is set.
      case "config":
        return { exitCode: 1, stdout: "", stderr: "" };
      case "status":
      case "ls-files":
        return answer("");
      // The directory is the only work tree, so the init copy of local files has
      // no main work tree to copy from.
      case "worktree":
        return answer(`worktree ${cwd}\nHEAD ${HEAD}\n\n`);
      default:
        throw new Error(`unexpected git call: ${args.join(" ")}`);
    }
  };
}

// Runs a review-only loop whose one reviewer turn returns `reply`, then checks
// that the finish after it was accepted and recorded what the turn returned.
//
// `git` is answered from memory, not spawned. A run takes a snapshot of four `git`
// processes around every turn, so two cases in one test spent about forty
// processes, and a loaded Windows runner outlasted the test limit (issue #385).
// Nothing here depends on a real repository: the behavior under test is the
// runtime's finish rule, and the snapshot code has its own tests on real repos.
async function expectFinishAcceptedAfterReviewerTurn(what, reply) {
  const cwd = await mkdtemp(join(tmpdir(), "review-only-finish-"));
  dirs.push(cwd);
  await mkdir(join(cwd, ".git"));
  execa.mockReset().mockImplementation(cleanRepoGit(cwd));
  const orchAdapter = scripted([
    JSON.stringify({ action: "run_reviewer", prompt: "inspect the repo" }),
    JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: what, deferred: "c", notDone: "d", open: "e" },
    }),
  ]);
  const reviewerAdapter = scripted([reply]);

  const result = await runLoop({
    task: "Review only.",
    cwd,
    maxSteps: 5,
    mode: "review-only",
    roles: {
      orchestrator: { kind: "orch", sessionId: null },
      worker: { kind: "work", sessionId: null },
      reviewer: { kind: "rev", sessionId: null },
    },
    agents: { orch: orchAdapter, work: scripted([]), rev: reviewerAdapter },
  });

  // The finish was accepted, so the run recorded it, whatever the turn returned.
  expect(result.exitCode, what).toBe(0);
  expect(result.summary.verified, what).toBe(what);
  expect(reviewerAdapter.recorded.length, what).toBe(1);
  // The turns were snapshotted, so the answered `git` is on the path under test.
  expect(execa).toHaveBeenCalled();
}

// Usefulness: verifies a review-only finish is accepted after a reviewer turn that ended in a handled error, because the interactive path accepts a finish after any reviewer turn (issue #337).
test("a review-only run accepts a finish after a reviewer turn that ended in a handled error", async () => {
  await expectFinishAcceptedAfterReviewerTurn(
    "a reviewer turn that ended in a handled error",
    () => {
      throw new Error("reviewer cli exited with code 1");
    },
  );
});

// Usefulness: verifies a review-only finish is accepted after a reviewer report with no verdict line, because the interactive path accepts a finish after any reviewer turn (issue #337).
test("a review-only run accepts a finish after a reviewer report with no verdict line", async () => {
  await expectFinishAcceptedAfterReviewerTurn(
    "a reviewer report with no verdict line",
    "Conclusion: read the code\nWhy: no verdict here\nBlockers: none",
  );
});
