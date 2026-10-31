// Requirement (#1265): a classic branch-protection reply whose `contexts` or `checks` is not an array
// is unknown and unparsed, never read element by element as check names.
import { expect, test } from "vite-plus/test";
import { requiredContexts, UNKNOWN } from "../../src/lib/ci-required-sources.mjs";
import { SLUG } from "./ci-gate-helpers.mjs";

const PROTECTION = `repos/${SLUG}/branches/main/protection`;

// A `gh` double: an empty ruleset page, the given protection body, and no other read.
const ghWith = (protection) => async (args) => {
  if (args[1]?.startsWith(`repos/${SLUG}/rules/`)) {
    return { status: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n[]", stderr: "" };
  }
  if (args[1] === PROTECTION) {
    return { status: 0, stdout: JSON.stringify(protection), stderr: "" };
  }
  return { status: 1, stdout: "", stderr: `unmatched gh call: ${JSON.stringify(args)}` };
};

const read = (protection) =>
  requiredContexts(ghWith(protection), SLUG, "main", 42, ".", {
    names: { ok: true, names: [] },
  });

// Usefulness: verifies a `contexts` or `checks` that is not an array names no check and refuses
// through `unparsed`, so `--require-ci` never reports one-character check names or throws on a number.
test.each([
  ["a string contexts", { required_status_checks: { contexts: "ci" } }],
  ["a number contexts", { required_status_checks: { contexts: 7 } }],
  ["a string checks", { required_status_checks: { contexts: [], checks: "ci" } }],
  ["a number checks", { required_status_checks: { contexts: [], checks: 7 } }],
])("reads %s as an unknown, unparsed protection source", async (_name, protection) => {
  const found = await read(protection);
  expect(found.protectionState).toBe(UNKNOWN);
  expect(found.contexts).toEqual([]);
  expect(found.unparsed).toEqual(["classic branch protection"]);
});

// Usefulness: verifies the well-formed array reply still names its contexts, so the guard does not
// refuse every protection body.
test("names the contexts of a well-formed protection reply", async () => {
  const found = await read({ required_status_checks: { contexts: ["ci"] } });
  expect(found.contexts).toEqual([{ name: "ci", appId: null }]);
  expect(found.unparsed).toEqual([]);
});
