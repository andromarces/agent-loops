import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { findOverrideProblems, readOverrides } from "./pnpm-workspace-overrides-helpers.mjs";

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

// Requirement: a vite-plus bump with stale overrides must fail CI (issue #1027).
// Not redundant: no other check compares the pinned overrides to the installed vite-plus.
test("pnpm-workspace overrides match the vite and vitest that vite-plus depends on", async () => {
  const overrides = readOverrides(await readFile(root("pnpm-workspace.yaml"), "utf8"));
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

// Requirement: the override reader returns the pinned values from the workspace file.
// Not redundant: guards the parser, so a format change cannot turn the drift check into a no-op.
test("readOverrides reads both pins from the workspace file format", () => {
  const yaml = "virtualStoreType: global\n\noverrides:\n  vite: npm:x@1.0.0\n  vitest: 5.0.5\n";
  expect(readOverrides(yaml)).toEqual({ vite: "npm:x@1.0.0", vitest: "5.0.5" });
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
