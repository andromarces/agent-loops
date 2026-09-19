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

      return {
        ok: true,
        value: {
          action: "finish",
          summary,
        },
      };
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
