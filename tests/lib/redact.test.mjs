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
