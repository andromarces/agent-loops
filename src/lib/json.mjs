export function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${description}:\n${text.slice(0, 2000)}`);
  }
}

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

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Response is not a JSON object." };
  }

  return { ok: true, value };
}
