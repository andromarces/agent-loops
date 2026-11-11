import { expect, test } from "vite-plus/test";
import { scriptedGh } from "./check-wait-helpers.mjs";

// Usefulness: verifies the scripted `gh` routes on the argument elements, so a
// call that merges the arguments into one element gets no reply and its error
// prints the array, which differs from the text of the expected call (issue #530).
test("the scripted gh gives no reply to a merged-argument call", async () => {
  const merged = ["pr checks 42 --required --json name,state,bucket"];
  const reply = await scriptedGh([{ checks: [] }])(merged, ".");
  expect(reply.status).toBe(1);
  expect(reply.stdout).toBe("");
  expect(reply.stderr).toContain(JSON.stringify(merged));
  const unfiltered = ["pr", "checks", "42", "--json", "name,state,bucket"];
  expect((await scriptedGh([{ checks: [] }])(unfiltered, ".")).status).toBe(1);
});
