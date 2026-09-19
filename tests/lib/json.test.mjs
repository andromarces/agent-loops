import { test, expect } from "vitest";
import { extractJsonObject } from "../../src/lib/json.mjs";

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
