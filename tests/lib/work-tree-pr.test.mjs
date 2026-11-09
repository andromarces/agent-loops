import { expect, test, vi } from "vite-plus/test";
import { readWorkTreePr } from "../../src/lib/work-tree-pr.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const onBranch = (branch) => async () => ({ exitCode: 0, stdout: `${branch}\n`, stderr: "" });
const reply = (entries) =>
  vi.fn(async () => ({
    status: 0,
    stdout: JSON.stringify(entries),
    stderr: "",
  }));
const read = (gh, git = onBranch("feat/1755")) =>
  readWorkTreePr({ cwd: "/repo", gh, git, signal: null });

// Usefulness: verifies the envelope reads one open PR for the checked-out branch. It stores the
// GitHub head in lowercase, so the parent gets the PR identity without a child report.
test("one open PR yields its number and lowercase head", async () => {
  const gh = reply([{ number: 7, headRefOid: HEAD.toUpperCase(), isCrossRepository: false }]);
  const result = await read(gh);

  expect(result).toEqual({ number: 7, head: HEAD });
  expect(gh.mock.calls[0][0].slice(0, 2)).toEqual(["pr", "list"]);
});

// Usefulness: verifies two open PRs yield no field, so an ambiguous branch never names one PR.
test("two open PRs yield no field", async () => {
  const gh = reply([
    { number: 7, headRefOid: HEAD, isCrossRepository: false },
    { number: 8, headRefOid: HEAD, isCrossRepository: false },
  ]);

  await expect(read(gh)).resolves.toBeNull();
});

// Usefulness: verifies a cross-repository PR yields no field, so a fork PR never stands in for the
// branch PR of the run repository.
test("a cross-repository PR yields no field", async () => {
  const gh = reply([{ number: 7, headRefOid: HEAD, isCrossRepository: true }]);

  await expect(read(gh)).resolves.toBeNull();
});

// Usefulness: verifies a malformed reply yields no field instead of a wrong PR number.
test("a malformed reply yields no field", async () => {
  const gh = vi.fn(async () => ({ status: 0, stdout: "not json", stderr: "" }));

  await expect(read(gh)).resolves.toBeNull();
});

// Usefulness: verifies a malformed entry yields no field, so a bad number or head never reaches the
// envelope.
test("a malformed entry yields no field", async () => {
  const gh = reply([{ number: 0, headRefOid: "abc", isCrossRepository: false }]);

  await expect(read(gh)).resolves.toBeNull();
});

// Usefulness: verifies a detached HEAD reads no GitHub state and yields no field.
test("a detached HEAD reads no PR and yields no field", async () => {
  const gh = reply([]);
  const git = async () => ({ exitCode: 1, stdout: "", stderr: "" });

  await expect(read(gh, git)).resolves.toBeNull();
  expect(gh).not.toHaveBeenCalled();
});
