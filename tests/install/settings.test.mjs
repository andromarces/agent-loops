import { expect, test } from "vitest";
import { parseSettings, validateLocator } from "../../src/install/settings.mjs";

// Usefulness: verifies a settings root that is not a JSON object is refused with its path; no other test reaches this error path.
test("parseSettings rejects a root that is not a JSON object", () => {
  for (const text of ["[]", "null", "7", '"x"']) {
    expect(() => parseSettings(text, "/home/settings.json")).toThrow(
      "Settings file is not a JSON object: /home/settings.json",
    );
  }
  expect(parseSettings('{"a":1}', "/home/settings.json")).toEqual({ a: 1 });
});

// Usefulness: verifies a non-object container on a locator path is refused with its location; no other test reaches this refusal.
test("validateLocator refuses a container that is not an object", () => {
  const locator = { kind: "array", path: ["hooks", "PreToolUse"] };

  expect(validateLocator([], locator)).toEqual({
    ok: false,
    reason: "expected an object at (root)",
  });
  expect(validateLocator({ hooks: [] }, locator)).toEqual({
    ok: false,
    reason: "expected an object at hooks",
  });
  expect(validateLocator({ hooks: null }, locator)).toEqual({
    ok: false,
    reason: "expected an object at hooks",
  });
  expect(validateLocator({ hooks: { PreToolUse: [] } }, locator)).toEqual({ ok: true });
});
