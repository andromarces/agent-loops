const SUMMARY_KEYS = ["changed", "verified", "deferred", "notDone", "open"];

export function validateAction(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Action must be an object." };
  }

  const { action } = value;

  // The case labels are the single source of truth for the supported action set:
  // any action without a branch falls to `default` and is rejected, so the
  // repair turn in decide() runs instead of a TypeError on an undefined result.
  switch (action) {
    case "run_worker":
    case "run_reviewer": {
      if (typeof value.prompt !== "string" || value.prompt.trim() === "") {
        return { ok: false, error: `${action} requires a non-empty string prompt.` };
      }
      return {
        ok: true,
        value: {
          action,
          prompt: value.prompt.trim(),
        },
      };
    }

    case "finish": {
      if (
        value.summary === null ||
        typeof value.summary !== "object" ||
        Array.isArray(value.summary)
      ) {
        return { ok: false, error: "finish requires a summary object." };
      }

      const summary = {};
      for (const key of SUMMARY_KEYS) {
        const fieldVal = value.summary[key];
        if (typeof fieldVal !== "string" || fieldVal.trim() === "") {
          return {
            ok: false,
            error: `finish summary requires a non-empty string for ${key}.`,
          };
        }
        summary[key] = fieldVal.trim();
      }

      const finish = {
        action: "finish",
        summary,
      };

      // Optional machine-readable marker the parent sets when it recorded an
      // unresolved PR-head compare instead of verifying it (#266). Free-text
      // `verified` cannot carry this, so the runtime emits a distinct
      // `unresolved-compare` transcript event on the strength of this field.
      //
      // known-limit: the marker is parent-set, and an omitted marker is
      // indistinguishable from a verified finish in a run that takes no PR input
      // (issue #286, accepted gap). A parent that records the unresolved compare
      // under `notDone` and `open` and omits this field yields a finish that
      // reads exactly like a verified one: loop exit 0, no `unresolved-compare`
      // event, no marker in the result, and the same for the interactive
      // envelope and state file. The omission needs the PR head to detect.
      // `--require-ci <pr>` is the PR input on both paths, and both refuse a
      // finish that sets this field because the gate resolves the compare, so a
      // gated run has nothing left to misreport (#293). `--pr <pr>` declares the
      // run PR work, so such a run must carry the gate for the same PR: a finish
      // with no gate, or with a gate for another PR, is refused, and a finish
      // that sets this field is refused with it (#302). That gate resolves the PR
      // head even on a base branch that states it has no required check, where it
      // verifies the head, the clean reviewed tree, and the merge state and
      // records that no required check exists, but only when every
      // required-check source stated that it holds none; a private Free-plan
      // repository cannot, so it must omit the declaration (#336). A run that
      // declares
      // neither keeps the gap: the headless loop holds the task text only, and
      // the interactive subcommand gates on the state file. Ceiling: one finish
      // that claims a compare nothing verified, per run that declares no PR.
      if (value.unresolvedCompare !== undefined) {
        if (typeof value.unresolvedCompare !== "boolean") {
          return { ok: false, error: "finish unresolvedCompare must be a boolean." };
        }
        finish.unresolvedCompare = value.unresolvedCompare;
      }

      return { ok: true, value: finish };
    }

    case "abort": {
      if (typeof value.reason !== "string" || value.reason.trim() === "") {
        return { ok: false, error: "abort requires a non-empty string reason." };
      }
      return {
        ok: true,
        value: {
          action: "abort",
          reason: value.reason.trim(),
        },
      };
    }

    default:
      return { ok: false, error: `Unsupported action: ${action}` };
  }
}
