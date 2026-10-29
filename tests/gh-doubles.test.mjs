import { test } from "vite-plus/test";
import {
  expectNoReplyToMalformedCalls,
  gateReadCalls,
  noRequiredCheckGh,
  prGateGh,
} from "./gh-doubles.mjs";

// Usefulness: acceptance (#538) — the shared `gh` doubles answer only the exact argument elements of each
// gate read, so a call that merges, drops, or adds an element gets no reply and its error prints the array.
test.each([
  ["prGateGh", prGateGh],
  ["noRequiredCheckGh", noRequiredCheckGh],
])("%s gives no reply to a malformed call", async (_name, double) => {
  const head = "1".repeat(40);
  await expectNoReplyToMalformedCalls(double(head), gateReadCalls(head));
});
