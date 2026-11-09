import { expect, test, vi } from "vite-plus/test";
import { readWorkTreePr } from "../../src/lib/work-tree-pr.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const onBranch = (branch) => async () => ({ exitCode: 0, stdout: `${branch}\n`, stderr: "" });

/** A gh double that names `owner/repo` and answers the list read with `entries`. */
function ghDouble({ entries = [], listStdout, repoStatus = 0, repoStderr = "" } = {}) {
  const calls = [];
  const gh = vi.fn(async (args, cwd, options = {}) => {
    calls.push({ args, options });
    if (args[0] === "repo" && args[1] === "view") {
      return repoStatus === 0
        ? { status: 0, stdout: "owner/repo\n", stderr: "" }
        : { status: repoStatus, stdout: "", stderr: repoStderr };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return {
        status: 0,
        stdout: listStdout ?? JSON.stringify(entries),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  });
  gh.calls = calls;
  return gh;
}

const read = (gh, git = onBranch("feat/1755")) =>
  readWorkTreePr({ cwd: "/repo", gh, git, signal: null });

// Usefulness: verifies the envelope reads one open PR for the branch, names the work tree
// repository, and stores the GitHub head in lowercase.
test("one open PR yields its number, head, and repository", async () => {
  const gh = ghDouble({
    entries: [{ number: 7, headRefOid: HEAD.toUpperCase(), isCrossRepository: false }],
  });
  const result = await read(gh);

  expect(result).toEqual({ number: 7, head: HEAD });
  const listCall = gh.calls.find((call) => call.args[0] === "pr");
  expect(listCall.args.slice(0, 5)).toEqual(["pr", "list", "--repo", "owner/repo", "--head"]);
  for (const call of gh.calls) {
    expect(call.options.dropEnv).toContain("GH_REPO");
  }
});

// Usefulness: verifies two open PRs yield no field, so an ambiguous branch never names one PR.
test("two open PRs yield no field", async () => {
  const gh = ghDouble({
    entries: [
      { number: 7, headRefOid: HEAD, isCrossRepository: false },
      { number: 8, headRefOid: HEAD, isCrossRepository: false },
    ],
  });

  await expect(read(gh)).resolves.toBeNull();
});

// Usefulness: verifies a cross-repository PR yields no field, so a fork PR never stands in for the
// branch PR of the run repository.
test("a cross-repository PR yields no field", async () => {
  const gh = ghDouble({ entries: [{ number: 7, headRefOid: HEAD, isCrossRepository: true }] });

  await expect(read(gh)).resolves.toBeNull();
});

// Usefulness: verifies a malformed reply yields no field instead of a wrong PR number.
test("a malformed reply yields no field", async () => {
  const gh = ghDouble({ listStdout: "not json" });

  await expect(read(gh)).resolves.toBeNull();
});

// Usefulness: verifies a malformed entry yields no field, so a bad number or head never reaches the
// envelope.
test("a malformed entry yields no field", async () => {
  const gh = ghDouble({ entries: [{ number: 0, headRefOid: "abc", isCrossRepository: false }] });

  await expect(read(gh)).resolves.toBeNull();
});

// Usefulness: verifies a detached HEAD reads no GitHub state and yields no field.
test("a detached HEAD reads no PR and yields no field", async () => {
  const gh = ghDouble();
  const git = async () => ({ exitCode: 1, stdout: "", stderr: "" });

  await expect(read(gh, git)).resolves.toBeNull();
  expect(gh).not.toHaveBeenCalled();
});

// Usefulness: verifies an unreadable repository yields no field and one warning line, so a
// multiline gh error cannot flood the log.
test("an unreadable repository yields no field and one warning line", async () => {
  const gh = ghDouble({ repoStatus: 1, repoStderr: "gh: first line\nsecond line" });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(read(gh)).resolves.toBeNull();
    expect(gh.calls.filter((call) => call.args[0] === "pr")).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain("work tree PR read failed");
    expect(line).not.toContain("\n");
  } finally {
    errorSpy.mockRestore();
  }
});
