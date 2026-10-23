import { expect, test } from "vite-plus/test";

test("deliberate failure for the live wait-checks prFailures check", () => {
  expect(1).toBe(2);
});
