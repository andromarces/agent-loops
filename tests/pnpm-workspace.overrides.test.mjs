import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { parse } from "yaml";

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

const KEYS = ["vite", "vitest"];

/**
 * Compares the `vite` and `vitest` overrides to the `vite-plus` dependencies.
 * Returns one message per key that is missing from either input or that differs;
 * an empty array means both keys match.
 */
function findOverrideProblems(overrides, dependencies, vitePlusVersion) {
  const problems = [];
  for (const key of KEYS) {
    const pinned = overrides[key];
    const wanted = dependencies[key];
    if (pinned === undefined) {
      problems.push(`  ${key}: missing from the overrides in pnpm-workspace.yaml`);
    }
    if (wanted === undefined) {
      problems.push(`  ${key}: missing from the dependencies of vite-plus@${vitePlusVersion}`);
    }
    if (pinned === undefined || wanted === undefined) continue;
    if (pinned !== wanted) {
      problems.push(
        `  ${key}: pnpm-workspace.yaml has "${pinned}", vite-plus@${vitePlusVersion} depends on "${wanted}"`,
      );
    }
  }
  return problems;
}

// Requirement: a vite-plus bump with stale overrides must fail CI (issue #1027).
// Not redundant: no other check compares the pinned overrides to the installed vite-plus.
test("pnpm-workspace overrides match the vite and vitest that vite-plus depends on", async () => {
  const { overrides = {} } = parse(await readFile(root("pnpm-workspace.yaml"), "utf8"));
  const { version, dependencies } = JSON.parse(
    await readFile(root("node_modules/vite-plus/package.json"), "utf8"),
  );
  const problems = findOverrideProblems(overrides, dependencies, version);
  expect(
    problems,
    `Override check failed:\n${problems.join("\n")}\n` +
      "Fix: set each override to the vite-plus value above, run `pnpm install`, and commit the lockfile.",
  ).toEqual([]);
});

// Requirement: the workspace file format yields both pins as strings.
// Not redundant: guards the parse, so a format change cannot turn the drift check into a no-op.
test("the workspace file format yields both pins as strings", () => {
  const text = "virtualStoreType: global\n\noverrides:\n  vite: npm:x@1.0.0\n  vitest: 5.0.5\n";
  expect(parse(text).overrides).toEqual({ vite: "npm:x@1.0.0", vitest: "5.0.5" });
});

// Requirement: matching values pass and a differing value is reported with both values.
// Not redundant: covers the comparison itself on inputs that the real files do not hold.
test("findOverrideProblems reports only the key whose values differ", () => {
  const overrides = { vite: "npm:x@1.0.0", vitest: "5.0.5" };
  const dependencies = { vite: "npm:x@1.3.0", vitest: "5.0.5" };
  const problems = findOverrideProblems(overrides, dependencies, "1.3.0");
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("vite");
  expect(problems[0]).toContain("npm:x@1.0.0");
  expect(problems[0]).toContain("npm:x@1.3.0");
  expect(findOverrideProblems(dependencies, dependencies, "1.3.0")).toEqual([]);
});

// Requirement: a key that is missing from both inputs must fail, not pass as equal (issue #1027).
// Not redundant: the drift test above reads the real files, which hold both keys.
test("findOverrideProblems fails when a key is missing from both inputs", () => {
  const problems = findOverrideProblems({ vitest: "5.0.5" }, { vitest: "5.0.5" }, "1.3.0");
  expect(problems).toHaveLength(2);
  expect(problems.join("\n")).toContain("vite");
  expect(problems.join("\n")).toContain("pnpm-workspace.yaml");
  expect(problems.join("\n")).toContain("vite-plus");
});

// Requirement: a key missing from one input names that input as the source of the gap.
// Not redundant: tells the maintainer which file to fix.
test("findOverrideProblems names the input that lacks the key", () => {
  const onlyDependency = findOverrideProblems({}, { vite: "a", vitest: "b" }, "1.3.0");
  expect(onlyDependency).toHaveLength(2);
  for (const problem of onlyDependency) expect(problem).toContain("pnpm-workspace.yaml");
  const onlyOverride = findOverrideProblems({ vite: "a", vitest: "b" }, {}, "1.3.0");
  expect(onlyOverride).toHaveLength(2);
  for (const problem of onlyOverride) expect(problem).toContain("vite-plus");
});
