import { expect, test, vi } from "vite-plus/test";
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

// Usefulness: verifies the refusal reason names the failing location, which the installer test "a wrong-typed settings container stops install with no write" does not assert (it checks the snippet and no write), and covers a null container that test never seeds.
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

// Usefulness: acceptance (#490) — a parse failure with an unreadable message still throws the
// settings error that names the file, so the original failure is not replaced by a getter error.
test("parseSettings names the file when the parse error has an unreadable message", () => {
  const spy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
    throw {
      get message() {
        throw new Error("getter");
      },
    };
  });
  try {
    expect(() => parseSettings("{}", "/home/settings.json")).toThrow(
      "Settings file does not parse: /home/settings.json",
    );
  } finally {
    spy.mockRestore();
  }
  expect(() => parseSettings("{nope", "/home/settings.json")).toThrow(
    /Settings file does not parse: \/home\/settings\.json \(.+\)/,
  );
});
