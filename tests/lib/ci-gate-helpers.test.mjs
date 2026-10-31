import { test } from "vite-plus/test";
import { expectNoReplyToMalformedCalls } from "../gh-doubles.mjs";
import { fakeGh, routes } from "./ci-gate-helpers.mjs";

// Usefulness: verifies the double routes on the argument elements, so a call
// that merges the arguments into one element gets no reply and its error prints
// the array, which differs from the text of the expected call (issue #530).
test("the gh double gives no reply to a malformed call", async () => {
  const calls = routes().map(([match]) => match.split(" "));
  await expectNoReplyToMalformedCalls(fakeGh(routes()), calls);
});
