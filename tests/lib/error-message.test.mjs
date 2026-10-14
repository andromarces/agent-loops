import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  errorMessage,
  firstErrorLine,
  readableErrorMessage,
  readableErrorText,
  readProp,
  redactedText,
  UNREADABLE_MESSAGE,
  UNSERIALIZABLE_MESSAGE,
} from "../../src/lib/error-message.mjs";

const SECRET = "synthetic-secret-value-4711";
const REDACTED = "[redacted:ERROR_MESSAGE_PROBE_TOKEN]";

afterEach(() => {
  vi.unstubAllEnvs();
});

const hostileGetter = () => ({
  get message() {
    throw new Error("getter boom");
  },
});

// Value whose serialization yields no value or throws, so no plain JSON message exists.
const unserializable = {
  function: () => {},
  symbol: Symbol("x"),
  "toJSON that returns undefined": { toJSON: () => undefined },
  "toJSON that throws": {
    toJSON() {
      throw new Error("toJSON boom");
    },
  },
};

describe("errorMessage", () => {
  // Usefulness: requirement — a string message reaches the envelope with secret-named environment
  // values redacted (ADR 0017). Not redundant: the callers re-test only that they print some value.
  test("redacts a secret-named environment value in a string message", () => {
    vi.stubEnv("ERROR_MESSAGE_PROBE_TOKEN", SECRET);
    expect(errorMessage(new Error(`failed with ${SECRET}`))).toBe(`failed with ${REDACTED}`);
  });

  // Usefulness: requirement — a thrown non-Error value becomes its string form, so the envelope
  // never carries `undefined` for a thrown string.
  test("uses the string form of a thrown value that has no message", () => {
    expect(errorMessage("plain failure")).toBe("plain failure");
  });

  // Usefulness: requirement — a non-string message keeps its JSON shape, and a secret inside it
  // turns the value into its redacted JSON text.
  test("keeps a non-string JSON message and redacts a secret inside it", () => {
    expect(errorMessage({ message: { code: 7 } })).toEqual({ code: 7 });
    vi.stubEnv("ERROR_MESSAGE_PROBE_TOKEN", SECRET);
    expect(errorMessage({ message: { detail: SECRET } })).toBe(`{"detail":"${REDACTED}"}`);
  });

  // Usefulness: requirement — a `toJSON` that redacts by key runs exactly once, because the
  // envelope and the state file must hold one value.
  test("runs a message toJSON exactly once", () => {
    const toJSON = vi.fn(() => ({ safe: true }));
    expect(errorMessage({ message: { toJSON } })).toEqual({ safe: true });
    expect(toJSON).toHaveBeenCalledTimes(1);
  });

  // Usefulness: requirement — a message that cannot serialize yields the fixed placeholder, so an
  // error envelope always carries `error`.
  test.each(Object.entries(unserializable))(
    "returns the placeholder for a message that is %s",
    (_name, message) => {
      expect(errorMessage({ message })).toBe(UNSERIALIZABLE_MESSAGE);
    },
  );

  // Usefulness: requirement — a BigInt message keeps its digits and still passes redaction.
  test("returns the digits of a BigInt message", () => {
    expect(errorMessage({ message: 12345678901234567890n })).toBe("12345678901234567890");
  });

  // Usefulness: requirement — reading a hostile `message` getter throws to the caller, which is
  // why the print paths use `readableErrorMessage`.
  test("throws when reading the message throws", () => {
    expect(() => errorMessage(hostileGetter())).toThrow("getter boom");
  });
});

describe("redactedText", () => {
  // Usefulness: requirement — any thrown value prints as text with secrets redacted.
  test("redacts a secret in a string and in a serialized object", () => {
    vi.stubEnv("ERROR_MESSAGE_PROBE_TOKEN", SECRET);
    expect(redactedText(`bad ${SECRET}`)).toBe(`bad ${REDACTED}`);
    expect(redactedText({ detail: SECRET })).toBe(`{"detail":"${REDACTED}"}`);
  });

  // Usefulness: requirement — a hostile `toJSON` or `toString` never escapes a print path.
  test("returns the placeholder when the value cannot be read or serialized", () => {
    const hostile = {
      toJSON() {
        throw new Error("boom");
      },
    };
    expect(redactedText(hostile)).toBe(UNSERIALIZABLE_MESSAGE);
    expect(
      redactedText(
        Object.create(null, {
          toString: {
            value() {
              throw new Error("boom");
            },
          },
        }),
      ),
    ).toBe("{}");
    expect(redactedText(Symbol.for("x"))).toBe("Symbol(x)");
    expect(redactedText(() => {})).toContain("=>");
  });

  // Usefulness: requirement — a value that serializes to nothing reads as the placeholder, not
  // as the text "undefined".
  test("returns the placeholder for a value that serializes to nothing", () => {
    expect(redactedText({ toJSON: () => undefined })).toBe(UNSERIALIZABLE_MESSAGE);
  });
});

describe("readableErrorMessage and readableErrorText", () => {
  // Usefulness: requirement — an unreadable message returns a fixed placeholder, so an error path
  // always has text to print.
  test("return the unreadable placeholder when the message getter throws", () => {
    expect(readableErrorMessage(hostileGetter())).toBe(UNREADABLE_MESSAGE);
    expect(readableErrorText(hostileGetter())).toBe(UNREADABLE_MESSAGE);
  });

  // Usefulness: requirement — a log line gets the JSON form of a non-string message, because a
  // string conversion of a parsed object with its own `toString` key throws.
  test("readableErrorText prints a non-string message as JSON", () => {
    const err = { message: { toString: "not a function", code: 7 } };
    expect(readableErrorText(err)).toBe('{"toString":"not a function","code":7}');
  });

  // Usefulness: requirement — a plain message passes through unchanged.
  test("readableErrorText passes a string message through", () => {
    expect(readableErrorText(new Error("plain"))).toBe("plain");
  });
});

describe("firstErrorLine", () => {
  // Usefulness: requirement — a log line shows only the first line of a multi-line error text, and
  // a single-line or empty text passes through unchanged.
  test("returns the text before the first newline", () => {
    expect(firstErrorLine("first\nsecond\nthird")).toBe("first");
    expect(firstErrorLine("only")).toBe("only");
    expect(firstErrorLine("")).toBe("");
  });
});

describe("readProp", () => {
  // Usefulness: requirement — a hostile getter never escapes an error path.
  test("returns undefined when the read throws and the value otherwise", () => {
    const err = {
      get code() {
        throw new Error("boom");
      },
      status: 7,
    };
    expect(readProp(err, "code")).toBeUndefined();
    expect(readProp(err, "status")).toBe(7);
    expect(readProp(null, "status")).toBeUndefined();
  });
});
