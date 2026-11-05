import { expect, test, vi } from "vite-plus/test";
import { checkCi, checkPrHead } from "../../src/lib/ci-gate.mjs";
import { fakeGh, REVIEWED, routes } from "./ci-gate-helpers.mjs";

// Usefulness: verifies the turn-order refusal names the worker turn after the review, so a parent
// does not read the failure as a reviewer fault (#1509).
test("checkCi names the worker turn after the last review", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: null,
    workerAfterReview: true,
    cwd: ".",
    gh: fakeGh(routes()),
  });
  expect(result).toEqual({
    ok: false,
    reason:
      "a worker turn ran after the last review, and a reviewer turn on the current state must come before finish",
  });
});

// Usefulness: verifies the origin/main refusal stays when no worker turn followed the review (#1509).
test("checkCi keeps the no-reviewed-state refusal without a worker turn after the review", async () => {
  const gh = vi.fn();
  const result = await checkCi({ pr: 42, reviewed: null, cwd: ".", gh });
  expect(result).toEqual({
    ok: false,
    reason: "the latest reviewer turn has no reviewed state",
  });
  expect(gh).not.toHaveBeenCalled();
});

// Usefulness: verifies the head compare reads the same turn-order fact as the CI gate, so the two
// refusals cannot drift (#1509).
test("checkPrHead names the worker turn after the last review", async () => {
  const result = await checkPrHead({
    pr: 42,
    reviewed: null,
    workerAfterReview: true,
    cwd: ".",
    gh: vi.fn(),
  });
  expect(result).toEqual({
    ok: false,
    reason:
      "a worker turn ran after the last review, and a reviewer turn on the current state must come before finish",
  });
});

// Usefulness: verifies the head compare keeps the origin/main refusal when no worker turn followed
// the review (#1509).
test("checkPrHead keeps the no-reviewed-state refusal without a worker turn after the review", async () => {
  const gh = vi.fn();
  const result = await checkPrHead({ pr: 42, reviewed: null, cwd: ".", gh });
  expect(result).toEqual({
    ok: false,
    reason: "the latest reviewer turn has no reviewed state",
  });
  expect(gh).not.toHaveBeenCalled();
});

// Usefulness: verifies a clean reviewed state still passes with the turn-order fact set, so the
// change alters only the reason text (#1509).
test("a clean reviewed state still passes the head compare", async () => {
  const gh = async () => ({
    status: 0,
    stdout: JSON.stringify({
      headRefOid: REVIEWED.head,
      state: "OPEN",
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      potentialMergeCommit: null,
    }),
    stderr: "",
  });
  const result = await checkPrHead({
    pr: 42,
    reviewed: REVIEWED,
    workerAfterReview: true,
    cwd: ".",
    gh,
  });
  expect(result).toEqual({ ok: true, commit: REVIEWED.head });
});
