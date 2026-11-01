import { test, expect } from "vite-plus/test";
import { extractJsonObject, parseJsonObjects } from "../../src/lib/json.mjs";

// Usefulness: verifies extractJsonObject parses bare JSON objects without fences.
test("extractJsonObject parses bare JSON object", () => {
  const input = '{"action": "run_worker", "prompt": "do something"}';
  const result = extractJsonObject(input);
  expect(result).toEqual({
    ok: true,
    value: { action: "run_worker", prompt: "do something" },
  });
});

// Usefulness: verifies extractJsonObject parses markdown fenced JSON objects.
test("extractJsonObject parses json-fenced JSON object", () => {
  const input = '```json\n{"action": "run_reviewer", "prompt": "inspect"}\n```';
  const result = extractJsonObject(input);
  expect(result).toEqual({
    ok: true,
    value: { action: "run_reviewer", prompt: "inspect" },
  });
});

// Usefulness: verifies extractJsonObject parses plain fenced JSON objects.
test("extractJsonObject parses plain fenced JSON object", () => {
  const input = '```\n{"action": "abort", "reason": "unrecoverable"}\n```';
  const result = extractJsonObject(input);
  expect(result).toEqual({
    ok: true,
    value: { action: "abort", reason: "unrecoverable" },
  });
});

// Usefulness: verifies extractJsonObject rejects prose mixed with JSON.
test("extractJsonObject rejects prose surrounding JSON", () => {
  const input = 'Here is the JSON:\n{"action": "run_worker", "prompt": "work"}\nDone.';
  const result = extractJsonObject(input);
  expect(result.ok).toBe(false);
  expect(result.error).toBe("Response is not valid JSON.");
});

// Usefulness: verifies extractJsonObject rejects JSON arrays.
test("extractJsonObject rejects JSON arrays", () => {
  const input = '[{"action": "run_worker", "prompt": "work"}]';
  const result = extractJsonObject(input);
  expect(result.ok).toBe(false);
  expect(result.error).toBe("Response is not a JSON object.");
});

// Usefulness: verifies extractJsonObject rejects malformed JSON.
test("extractJsonObject rejects malformed JSON", () => {
  const input = '{"action": "run_worker", invalid}';
  const result = extractJsonObject(input);
  expect(result.ok).toBe(false);
  expect(result.error).toBe("Response is not valid JSON.");
});

// Usefulness: verifies parseJsonObjects keeps each complete object of an output whose tail is
// truncated, so an adapter still reads an event the CLI already wrote.
test("parseJsonObjects keeps the complete objects before a truncated tail", () => {
  const input = '[{"type":"result","api_error_status":529},{"type":"resu';
  expect(parseJsonObjects(input)).toEqual([{ type: "result", api_error_status: 529 }]);
});

// Usefulness: verifies a brace or escape inside a string does not end an object early, so JSON
// punctuation in a result text still parses whole.
test("parseJsonObjects ignores braces inside strings", () => {
  const input = '{"text":"a } b \\" { c"}';
  expect(parseJsonObjects(input)).toEqual([{ text: 'a } b " { c' }]);
});
