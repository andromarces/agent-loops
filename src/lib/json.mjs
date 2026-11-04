export function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${description}:\n${text.slice(0, 2000)}`);
  }
}

/**
 * Parses `text` as JSON, or returns null when it is not JSON. A JSON `null` reads the same as an
 * unreadable text, so a caller that must tell them apart parses itself.
 */
export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parses each non-blank line as JSON and drops every line that does not parse, without a warning.
 * Returns the parsed values in input order.
 */
export function parseJsonLines(text) {
  const events = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }

  return events;
}

/**
 * Returns each complete top-level JSON object in `text`, in order. An object that does not parse,
 * and an incomplete tail, are skipped, so a truncated final line keeps the earlier objects.
 */
export function parseJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          objects.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Not an object this reader can use; the next one still counts.
        }
        start = -1;
      }
    }
  }

  return objects;
}

/** True for a JSON object, which excludes null and an array. */
export function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses a JSON object from `text`, after removing one surrounding Markdown code fence.
 * Returns `{ ok: true, value }` for a top-level object, else `{ ok: false, error }`.
 */
export function extractJsonObject(text) {
  let trimmed = text.trim();

  if (trimmed.startsWith("```")) {
    const lines = trimmed.split(/\r?\n/);
    lines.shift();
    if (lines.length > 0 && lines[lines.length - 1].trim().startsWith("```")) {
      lines.pop();
    }
    trimmed = lines.join("\n").trim();
  }

  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Response is not valid JSON." };
  }

  if (!isJsonObject(value)) {
    return { ok: false, error: "Response is not a JSON object." };
  }

  return { ok: true, value };
}
