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
      // indistinguishable from a verified finish (issue #286, accepted gap). A
      // parent that records the unresolved compare under `notDone` and `open`
      // and omits this field yields a finish that reads exactly like a verified
      // one: loop exit 0, no `unresolved-compare` event, no marker in the result,
      // and the same for the interactive envelope and state file. The omission
      // needs the PR head to detect, and only the parent has it: the headless
      // loop holds the task text and takes no PR input, and `--require-ci <pr>`
      // is the interactive path's only PR input. Ceiling: one finish that claims
      // a compare nothing verified, per run. Upgrade path: resolve the PR head
      // in the runtime (extend `--require-ci` to the headless loop), so the
      // outcome comes from a gate result rather than a parent-declared field and
      // this marker stops being the only signal.
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
