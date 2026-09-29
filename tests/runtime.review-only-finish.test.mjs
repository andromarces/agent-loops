import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { runLoop } from "../src/runtime.mjs";
import { scripted } from "./runtime-helpers.mjs";

const HEAD = "1111111111111111111111111111111111111111";

// A clean repo at one commit, answered from memory. The real snapshot code still
// runs over these answers, so a turn that changed the repo is still detected by
// the difference between two snapshots; only the `git` processes are gone.
function cleanRepoGit(cwd) {
  return async (command, args) => {
    expect(command).toBe("git");
    const answer = (stdout) => ({ exitCode: 0, stdout, stderr: "" });
    switch (args[0]) {
      case "rev-parse":
        return answer(args.includes("--show-toplevel") ? cwd : `${HEAD}\n`);
      case "status":
      case "ls-files":
        return answer("");
      default:
        throw new Error(`unexpected git call: ${args.join(" ")}`);
    }
  };
}

// Usefulness: verifies a review-only finish is allowed once a reviewer turn ran,
// whatever that turn returned, because the interactive path accepts the finish
// from `active` after any reviewer turn. A handled reviewer error and a reviewer
// report with no verdict both satisfy the gate; the summary records what the turn
// returned, so nothing is hidden by accepting it (issue #337).
//
// `git` is answered from memory, not spawned. A run takes a snapshot of four `git`
// processes around every turn, so the two cases spent about forty processes in
// one test, and a loaded Windows runner outlasted the test limit (issue #385).
// Nothing here depends on a real repository: the behavior under test is the
// runtime's finish rule, and the snapshot code has its own tests on real repos.
const cases = [
  {
    what: "a reviewer turn that ended in a handled error",
    reply: () => {
      throw new Error("reviewer cli exited with code 1");
    },
  },
  {
    what: "a reviewer report with no verdict line",
    reply: "Conclusion: read the code\nWhy: no verdict here\nBlockers: none",
  },
];

test.each(cases)("a review-only run accepts a finish after $what", async ({ what, reply }) => {
  const cwd = tmpdir();
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
});
