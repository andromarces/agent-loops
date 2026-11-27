import { expect, test } from "vite-plus/test";
import { pageStdout } from "../gh-doubles.mjs";
import { overlapReportOf } from "../../src/batch/overlap.mjs";

const loop = (pr, status = "succeeded") => ({ status, pr });
const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
const failure = { status: 1, stdout: "", stderr: "no such pull request" };

/**
 * A gh double for the repository read, the changed-file count, and the paged file list of a pull
 * request. `fail` refuses a number, and `mismatch` reports one changed file more than the list.
 */
function ghWith(files, { fail = new Set(), mismatch = new Set() } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "repo" && args[1] === "view" && args.includes("nameWithOwner")) {
      return json({ nameWithOwner: "o/r" });
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("changedFiles")) {
      const pr = Number(args[2]);
      if (fail.has(pr)) return failure;
      const count = (files.get(pr) ?? []).length + (mismatch.has(pr) ? 1 : 0);
      return json({ changedFiles: count });
    }
    const page = /\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)$/.exec(args[1] ?? "");
    if (args[0] === "api" && page !== null && args[2] === "--include") {
      const pr = Number(page[1]);
      if (fail.has(pr)) return failure;
      const start = (Number(page[2]) - 1) * 100;
      const list = (files.get(pr) ?? []).slice(start, start + 100);
      return { status: 0, stdout: pageStdout(list.map((filename) => ({ filename }))), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { gh, calls };
}

/** `count` paths with one shared path at `index` and a per-prefix name for every other path. */
function filesAt(count, shared, index, prefix) {
  return Array.from({ length: count }, (_, i) => (i === index ? shared : `${prefix}/f${i}.mjs`));
}

// Usefulness: a shared path beyond the first 100 files forms a group, so a truncated first page
// never reads as no overlap.
test("a shared path beyond the first 100 files forms a group", async () => {
  const files = new Map([
    [11, filesAt(205, "src/shared.mjs", 150, "left")],
    [12, filesAt(205, "src/shared.mjs", 150, "right")],
  ]);
  const { gh } = ghWith(files);
  const report = await overlapReportOf({
    loops: [loop(11), loop(12)],
    gh,
    repo: "/repo",
    warn: () => {},
  });
  expect(report).toEqual({
    groups: [{ pulls: [11, 12], paths: ["src/shared.mjs"] }],
    incomplete: [],
  });
});

// Usefulness: a chain of shared files is one group that names every shared path, so a member that
// shares no path with the first member is not lost.
test("a chain of shared files forms one group with every common path", async () => {
  const { gh } = ghWith(
    new Map([
      [1, ["a.mjs"]],
      [2, ["a.mjs", "b.mjs"]],
      [3, ["b.mjs"]],
    ]),
  );
  const report = await overlapReportOf({
    loops: [loop(1), loop(2), loop(3)],
    gh,
    repo: "/repo",
    warn: () => {},
  });
  expect(report).toEqual({
    groups: [{ pulls: [1, 2, 3], paths: ["a.mjs", "b.mjs"] }],
    incomplete: [],
  });
});

// Usefulness: a batch with no common file reports no group, and a loop that did not succeed is
// never read, so a failed loop cannot create a false group.
test("a batch with no common file reports no group", async () => {
  const { gh, calls } = ghWith(
    new Map([
      [1, ["a.mjs"]],
      [2, ["b.mjs"]],
      [3, ["a.mjs"]],
    ]),
  );
  const report = await overlapReportOf({
    loops: [loop(1), loop(2), loop(3, "failed")],
    gh,
    repo: "/repo",
    warn: () => {},
  });
  expect(report).toEqual({ groups: [], incomplete: [] });
  expect(calls.some((call) => call.includes("pr view 3 "))).toBe(false);
});

// Usefulness: a loop without a recorded pull request is skipped without a read, so a batch of
// tasks and one pull request makes no file-list read.
test("a loop without a pull request makes no file-list read", async () => {
  const { gh, calls } = ghWith(new Map([[11, ["a.mjs"]]]));
  const report = await overlapReportOf({
    loops: [loop(null), loop(11)],
    gh,
    repo: "/repo",
    warn: () => {},
  });
  expect(report).toEqual({ groups: [], incomplete: [] });
  expect(calls).toEqual([]);
});

// Usefulness: a failed file-list read logs a warning, names the pull request as incomplete, and
// leaves out only that pull request, so the other pair still reports its group.
test("a failed file-list read logs a warning and names the pull request incomplete", async () => {
  const { gh } = ghWith(
    new Map([
      [11, ["a.mjs"]],
      [12, ["a.mjs"]],
      [13, ["a.mjs"]],
    ]),
    { fail: new Set([12]) },
  );
  const warnings = [];
  const report = await overlapReportOf({
    loops: [loop(11), loop(12), loop(13)],
    gh,
    repo: "/repo",
    warn: (message) => warnings.push(message),
  });
  expect(report).toEqual({ groups: [{ pulls: [11, 13], paths: ["a.mjs"] }], incomplete: [12] });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("12");
  expect(warnings[0]).toContain("incomplete");
});

// Usefulness: a list whose length differs from the changed-file count is reported as incomplete
// instead of a silent no group, because the read cannot prove it saw every file.
test("a file list shorter than the changed-file count is incomplete", async () => {
  const { gh } = ghWith(
    new Map([
      [11, ["a.mjs", "b.mjs"]],
      [12, ["a.mjs"]],
    ]),
    { mismatch: new Set([12]) },
  );
  const warnings = [];
  const report = await overlapReportOf({
    loops: [loop(11), loop(12)],
    gh,
    repo: "/repo",
    warn: (message) => warnings.push(message),
  });
  expect(report).toEqual({ groups: [], incomplete: [12] });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("incomplete");
});

// Usefulness: a list at the 3000-file API cap is reported as incomplete, because the API may have
// stopped at the cap and the read cannot prove it saw every file.
test("a file list at the API cap is incomplete", async () => {
  const { gh } = ghWith(
    new Map([
      [11, filesAt(3000, "src/shared.mjs", 2999, "left")],
      [12, filesAt(3000, "src/shared.mjs", 2999, "right")],
    ]),
  );
  const warnings = [];
  const report = await overlapReportOf({
    loops: [loop(11), loop(12)],
    gh,
    repo: "/repo",
    warn: (message) => warnings.push(message),
  });
  expect(report).toEqual({ groups: [], incomplete: [11, 12] });
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain("3000");
});
