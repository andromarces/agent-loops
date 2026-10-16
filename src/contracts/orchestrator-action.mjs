import { isJsonObject } from "../lib/json.mjs";

export const SUMMARY_KEYS = ["changed", "verified", "deferred", "notDone", "open"];

/**
 * The four action formats as one-line JSON, for the orchestrator prompts. Each
 * prompt passes its own placeholder text, so the field set stays in this
 * contract while the wording stays with the prompt. Keep in step with
 * `validateAction` below.
 * @param {{worker: string, reviewer: string, summary: string, reason: string}} placeholders
 */
export function actionFormats({ worker, reviewer, summary, reason }) {
  const summaryJson = `{${SUMMARY_KEYS.map((key) => `"${key}": "${summary}"`).join(", ")}}`;
  const finish = (tail) => `{"action": "finish", "summary": ${summaryJson}${tail}}`;
  return {
    runWorker: `{"action": "run_worker", "prompt": "${worker}"}`,
    runReviewer: `{"action": "run_reviewer", "prompt": "${reviewer}"}`,
    finish: finish(""),
    finishUnresolved: finish(', "unresolvedCompare": true'),
    abort: `{"action": "abort", "reason": "${reason}"}`,
  };
}

/**
 * Validates one parsed orchestrator reply. Returns `{ ok: true, value }` with a new
 * action object, or `{ ok: false, error }`. String fields are trimmed, and a key
 * outside the action's field set is dropped.
 * @param {unknown} value
 */
export function validateAction(value) {
  if (!isJsonObject(value)) {
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
      if (!isJsonObject(value.summary)) {
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

      // Optional marker the parent sets when it recorded an unresolved PR-head
      // compare instead of verifying it. The runtime emits a distinct
      // `unresolved-compare` transcript event on this field (#266).
      //
      // known-limit: the marker is parent-set. In a run that declares no PR, an
      // omitted marker reads as a verified finish: one unverified claim per such
      // run. `--require-ci <pr>` and `--pr <pr>` close the gap by gating the
      // finish on the PR head, and both refuse a finish that sets this field
      // (issues #286, #293, #302, #336).
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
