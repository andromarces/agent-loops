import { expect, test } from "vite-plus/test";
import { pollUntil } from "./wait-helpers.mjs";

// Usefulness: a probe that never settles must not hold the wait past its deadline (#647 review).
// No other test covers the polling helper.
test("pollUntil rejects at its deadline when a probe never settles", async () => {
  const started = performance.now();
  await expect(pollUntil(() => new Promise(() => {}), 100)).rejects.toThrow(
    /not met within 100 ms/,
  );
  expect(performance.now() - started).toBeLessThan(2000);
  await expect(pollUntil(async () => 7, 100)).resolves.toBe(7);
});

// Usefulness: a probe result that arrives after the deadline must be rejected, even when the timer
// callback has not run yet (#647 review). The probe blocks the event loop past the deadline, so the
// timer cannot fire first.
test("pollUntil rejects a probe result that arrives after the deadline", async () => {
  const late = () => {
    const until = performance.now() + 150;
    while (performance.now() < until) {
      // Busy wait: the result is ready only after the 100 ms deadline.
    }
    return 7;
  };
  await expect(pollUntil(late, 100)).rejects.toThrow(/not met within 100 ms/);
});
