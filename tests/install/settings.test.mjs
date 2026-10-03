import { expect, test } from "vitest";
import { parseSettings, validateLocator } from "../../src/install/settings.mjs";

// Usefulness: verifies a settings file whose root is not an object is refused with the path, so a
// JSON array or scalar is never merged into.
test("parseSettings rejects a root that is not a JSON object", () => {
  for (const text of ["[]", "null", "7", '"x"']) {
    expect(() => parseSettings(text, "/home/settings.json")).toThrow(
      "Settings file is not a JSON object: /home/settings.json",
    );
  }
  expect(parseSettings('{"a":1}', "/home/settings.json")).toEqual({ a: 1 });
});

// Usefulness: verifies a wrong-typed container on a locator path is refused with its location, so
// the installer prints the manual snippet instead of writing into an array or scalar.
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
