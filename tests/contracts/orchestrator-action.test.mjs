import { describe, expect, test } from "vitest";
import {
  actionFormats,
  SUMMARY_KEYS,
  validateAction,
} from "../../src/contracts/orchestrator-action.mjs";

// Usefulness: verifies valid run_worker action shape is accepted and extra fields are pruned.
test("validateAction accepts valid run_worker and drops unknown fields", () => {
  const input = { action: "run_worker", prompt: "implement feature", extra: 123 };
  const result = validateAction(input);
  expect(result).toEqual({
    ok: true,
    value: { action: "run_worker", prompt: "implement feature" },
  });
});

// Usefulness: verifies valid run_reviewer action shape is accepted.
test("validateAction accepts valid run_reviewer", () => {
  const input = { action: "run_reviewer", prompt: "verify feature" };
  const result = validateAction(input);
  expect(result).toEqual({
    ok: true,
    value: { action: "run_reviewer", prompt: "verify feature" },
  });
});

// Usefulness: verifies valid finish action with complete summary object is accepted and extra summary keys or root keys are dropped.
test("validateAction accepts valid finish with summary", () => {
  const input = {
    action: "finish",
    summary: {
      changed: "all",
      verified: "tests pass",
      deferred: "none",
      notDone: "none",
      open: "none",
      extraSummary: "ignore",
    },
    rootExtra: "drop",
  };
  const result = validateAction(input);
  expect(result).toEqual({
    ok: true,
    value: {
      action: "finish",
      summary: {
        changed: "all",
        verified: "tests pass",
        deferred: "none",
        notDone: "none",
        open: "none",
      },
    },
  });
});

// Usefulness: verifies a finish that marks an unresolved PR-head compare keeps
// the machine-readable marker, so the runtime can emit a distinct event (#266).
test("validateAction keeps finish unresolvedCompare", () => {
  const input = {
    action: "finish",
    summary: {
      changed: "all",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "compared reviewed.head with the PR head",
      open: "PR head unresolved",
    },
    unresolvedCompare: true,
  };
  const result = validateAction(input);
  expect(result).toEqual({
    ok: true,
    value: {
      action: "finish",
      summary: {
        changed: "all",
        verified: "not verified: PR head unresolved",
        deferred: "none",
        notDone: "compared reviewed.head with the PR head",
        open: "PR head unresolved",
      },
      unresolvedCompare: true,
    },
  });
});

// Usefulness: verifies valid abort action is accepted.
test("validateAction accepts valid abort", () => {
  const input = { action: "abort", reason: "cannot continue" };
  const result = validateAction(input);
  expect(result).toEqual({
    ok: true,
    value: { action: "abort", reason: "cannot continue" },
  });
});

describe("validateAction rejections", () => {
  // Usefulness: verifies non-plain objects are rejected.
  test.each([null, undefined, "string", 123, [], true])("rejects non-object: %j", (val) => {
    const result = validateAction(val);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Action must be an object.");
  });

  // Usefulness: verifies unknown actions are rejected with required message.
  test("rejects unknown action", () => {
    const result = validateAction({ action: "unknown_act" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unsupported action: unknown_act");
  });

  // Usefulness: pins the repair-path contract from #32 — any unhandled action
  // value must yield a defined ok:false result so decide() runs the repair turn
  // instead of throwing a TypeError on an undefined result.
  test("returns a defined rejection for an unhandled action value", () => {
    const result = validateAction({ action: "teleport" });
    expect(result).toBeDefined();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unsupported action: teleport");
  });

  // Usefulness: verifies run_worker requires non-empty prompt.
  test.each(["", "   ", null, undefined, 123])(
    "rejects run_worker with invalid prompt: %j",
    (prompt) => {
      const result = validateAction({ action: "run_worker", prompt });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("run_worker requires a non-empty string prompt.");
    },
  );

  // Usefulness: verifies run_reviewer requires non-empty prompt.
  test.each(["", "   ", null, undefined, 123])(
    "rejects run_reviewer with invalid prompt: %j",
    (prompt) => {
      const result = validateAction({ action: "run_reviewer", prompt });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("run_reviewer requires a non-empty string prompt.");
    },
  );

  // Usefulness: verifies finish requires a valid summary object with all 5 keys.
  test("rejects finish with non-object summary", () => {
    const result = validateAction({ action: "finish", summary: "invalid" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("finish requires a summary object.");
  });

  test.each(["changed", "verified", "deferred", "notDone", "open"])(
    "rejects finish when %s summary field is missing or empty",
    (key) => {
      const summary = {
        changed: "all",
        verified: "tests",
        deferred: "none",
        notDone: "none",
        open: "none",
      };
      summary[key] = "   ";
      const result = validateAction({ action: "finish", summary });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(`finish summary requires a non-empty string for ${key}.`);
    },
  );

  // Usefulness: verifies the unresolved-compare marker is machine-readable, so
  // a non-boolean value is rejected rather than silently treated as present (#266).
  test.each(["yes", 1, null, {}])(
    "rejects finish with a non-boolean unresolvedCompare: %j",
    (unresolvedCompare) => {
      const result = validateAction({
        action: "finish",
        summary: {
          changed: "all",
          verified: "tests",
          deferred: "none",
          notDone: "none",
          open: "none",
        },
        unresolvedCompare,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("finish unresolvedCompare must be a boolean.");
    },
  );

  // Usefulness: verifies abort requires a non-empty string reason.
  test.each(["", "   ", null, undefined, 123])(
    "rejects abort with invalid reason: %j",
    (reason) => {
      const result = validateAction({ action: "abort", reason });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("abort requires a non-empty string reason.");
    },
  );
});

// Usefulness: the prompt format lines come from the contract, so a rendered format that validateAction rejects fails here.
describe("actionFormats", () => {
  const formats = actionFormats({ worker: "w", reviewer: "r", summary: "s", reason: "x" });

  test("renders every action format as JSON that validateAction accepts", () => {
    const lines = [
      formats.runWorker,
      formats.runReviewer,
      formats.finish,
      formats.finishUnresolved,
      formats.abort,
    ];
    for (const line of lines) {
      expect(validateAction(JSON.parse(line)).ok, line).toBe(true);
    }
  });

  test("renders one summary key per SUMMARY_KEYS entry, in order", () => {
    expect(Object.keys(JSON.parse(formats.finish).summary)).toEqual(SUMMARY_KEYS);
  });

  test("adds only the unresolvedCompare marker to the finish format", () => {
    expect(JSON.parse(formats.finishUnresolved)).toEqual({
      ...JSON.parse(formats.finish),
      unresolvedCompare: true,
    });
  });
});
