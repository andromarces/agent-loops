import { expect, test } from "vite-plus/test";
import { overlapGroupsOf } from "../../src/batch/overlap.mjs";

const loop = (pr, status = "succeeded") => ({ status, pr });

// A gh double that serves the file list of a pull request, and refuses the numbers in `fail`.
function ghWith(files, { fail = new Set() } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(" "));
    const pr = Number(args[2]);
    if (fail.has(pr)) return { status: 1, stdout: "", stderr: "no such pull request" };
    const list = files.get(pr) ?? [];
    return {
      status: 0,
      stdout: JSON.stringify({ files: list.map((path) => ({ path })) }),
      stderr: "",
    };
  };
  return { gh, calls };
}

// Usefulness: two succeeded loops that change one common file are reported as one group with the
// common path, which is the report the batch summary lacks today.
test("two succeeded loops that share a file form one group", async () => {
  const { gh } = ghWith(
    new Map([
      [11, ["src/handler.mjs", "README.md"]],
      [12, ["src/handler.mjs", "adr/README.md"]],
    ]),
  );
  const groups = await overlapGroupsOf({
    loops: [loop(11), loop(12)],
    gh,
    repo: "/repo",
    warn: () => {},
  });
  expect(groups).toEqual([{ pulls: [11, 12], paths: ["src/handler.mjs"] }]);
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
  const groups = await overlapGroupsOf({
    loops: [loop(1), loop(2), loop(3)],
    gh,
    repo: "/repo",
    warn: () => {},
  });
  expect(groups).toEqual([{ pulls: [1, 2, 3], paths: ["a.mjs", "b.mjs"] }]);
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
  const groups = await overlapGroupsOf({
    loops: [loop(1), loop(2), loop(3, "failed")],
    gh,
    repo: "/repo",
    warn: () => {},
  });
  expect(groups).toEqual([]);
  expect(calls).toEqual(["pr view 1 --json files", "pr view 2 --json files"]);
});

// Usefulness: a loop without a recorded pull request is skipped without a read, so a batch of
// tasks and one pull request makes no file-list read.
test("a loop without a pull request makes no file-list read", async () => {
  const { gh, calls } = ghWith(new Map([[11, ["a.mjs"]]]));
  const groups = await overlapGroupsOf({
    loops: [loop(null), loop(11)],
    gh,
    repo: "/repo",
    warn: () => {},
  });
  expect(groups).toEqual([]);
  expect(calls).toEqual([]);
});

// Usefulness: a failed file-list read logs a warning and leaves out only that pull request, and the
// other pair still reports its group.
test("a failed file-list read logs a warning and leaves out only that pull request", async () => {
  const { gh } = ghWith(
    new Map([
      [11, ["a.mjs"]],
      [12, ["a.mjs"]],
      [13, ["a.mjs"]],
    ]),
    { fail: new Set([12]) },
  );
  const warnings = [];
  const groups = await overlapGroupsOf({
    loops: [loop(11), loop(12), loop(13)],
    gh,
    repo: "/repo",
    warn: (message) => warnings.push(message),
  });
  expect(groups).toEqual([{ pulls: [11, 13], paths: ["a.mjs"] }]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("12");
  expect(warnings[0]).toContain("file list");
});

// Usefulness: a reply of the wrong shape is a failed read that logs a warning, not a crash and not
// an empty file list that reads as no overlap.
test("a malformed file-list reply logs a warning", async () => {
  const gh = async () => ({ status: 0, stdout: JSON.stringify({ files: [{}] }), stderr: "" });
  const warnings = [];
  const groups = await overlapGroupsOf({
    loops: [loop(11), loop(12)],
    gh,
    repo: "/repo",
    warn: (message) => warnings.push(message),
  });
  expect(groups).toEqual([]);
  expect(warnings).toHaveLength(2);
});
