import { describe, expect, test } from "vitest";
import { validateAction } from "../../src/contracts/orchestrator-action.mjs";

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
