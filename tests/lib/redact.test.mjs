import { expect, test } from "vite-plus/test";
import { redactEnvSecrets } from "../../src/lib/redact.mjs";

// Usefulness: verifies #515 scope — output for non-overlapping secrets stays what it was before the
// longest-first ordering: raw and JSON-escaped forms get their markers, short or non-secret
// variables are left alone. Not redundant with the log test, which covers only the prefix case.
test("non-overlapping secrets are replaced with their markers, as before", () => {
  const env = {
    API_TOKEN: "tok-12345678",
    DB_PASSWORD: 'pa"ss\nword-9',
    SHORT_KEY: "abc",
    HOME: "/home/someone-long-enough",
  };
  const text = `a tok-12345678 b ${JSON.stringify(env.DB_PASSWORD)} c abc d /home/someone-long-enough`;

  expect(redactEnvSecrets(text, env)).toBe(
    `a [redacted:API_TOKEN] b "[redacted:DB_PASSWORD]" c abc d /home/someone-long-enough`,
  );
});

// Usefulness: verifies the interval contract — crossing values of unequal length are covered as
// one span, so no fragment of either secret stays in the output.
test("crossing secrets of unequal length leave no fragment", () => {
  const env = { A_TOKEN: "abcdefghij", B_TOKEN: "ghijklmnopqr" };

  expect(redactEnvSecrets("x abcdefghijklmnopqr y", env)).toBe("x [redacted:A_TOKEN] y");
});

// Usefulness: verifies the interval contract — overlapping occurrences of one self-overlapping
// value are covered as one span, which a split-and-join of the first match would not do.
test("a self-overlapping occurrence leaves no fragment", () => {
  const env = { A_TOKEN: "abababab" };

  expect(redactEnvSecrets("x abababababab y", env)).toBe("x [redacted:A_TOKEN] y");
});

// Usefulness: verifies the interval contract across forms — the raw form of a longer-valued secret
// is a prefix of the JSON-escaped form of a shorter-valued one, and no fragment of the latter stays.
test("a raw and JSON-escaped prefix pair leaves no fragment", () => {
  const escaped = { A_TOKEN: 'a"b"c"d"e' };
  const env = { ...escaped, B_TOKEN: String.raw`a\"b\"c\"d` };
  const text = JSON.stringify(escaped.A_TOKEN).slice(1, -1);

  expect(redactEnvSecrets(`x ${text} y`, env)).toBe("x [redacted:A_TOKEN] y");
});

// Usefulness: verifies the marker is never rescanned — a secret value that equals part of another
// variable's name does not alter that variable's marker.
test("a secret value inside another variable's name leaves its marker intact", () => {
  const env = { A_TOKEN: "ALPHA_SECRET", ALPHA_SECRET_KEY: "other-value-1" };

  expect(redactEnvSecrets("x other-value-1 y ALPHA_SECRET z", env)).toBe(
    "x [redacted:ALPHA_SECRET_KEY] y [redacted:A_TOKEN] z",
  );
});
