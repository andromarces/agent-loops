import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

// Answers the `git` reads of the resolver from memory, so each test stays in one process.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("../../src/lib/exec.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execBounded: (command, args, options) =>
      command === "git" ? gitDouble.answer(args) : real.execBounded(command, args, options),
  };
});

import { resolveWorkerPr } from "../../src/lib/worker-pr.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "feat/1877";
const ALIAS_REMOTE = "git@github-work:owner/repo.git";
const REASON = "PR 42 is not in the repository of remote origin";

// The branch state that the resolver reads: one branch, no configured branch remote, and `url` on
// `origin`.
function runState(url = ALIAS_REMOTE) {
  return (args) => {
    const ok = (stdout) => ({ exitCode: 0, stdout, stderr: "" });
    switch (JSON.stringify(args)) {
      case '["rev-parse","--verify","-q","HEAD"]':
        return ok(`${HEAD}\n`);
      case '["symbolic-ref","--short","-q","HEAD"]':
        return ok(`${BRANCH}\n`);
      case `["config","--get","branch.${BRANCH}.remote"]`:
        return { exitCode: 1, stdout: "", stderr: "" };
      case '["remote","get-url","origin"]':
        return ok(`${url}\n`);
      default:
        throw new Error(`unexpected git read: ${args.join(" ")}`);
    }
  };
}

// A `gh pr list` double that answers `entries`.
const listGh = (entries) => async () => ({
  status: 0,
  stdout: JSON.stringify(entries),
  stderr: "",
});

const pr = (url) => ({
  number: 42,
  headRefName: BRANCH,
  headRefOid: HEAD,
  isCrossRepository: false,
  url,
});

// An `ssh -G` double that answers `stdout`, and records each host it receives.
function sshDouble(stdout, { status = 0 } = {}) {
  const hosts = [];
  const ssh = async (args) => {
    hosts.push(args[1]);
    return { status, stdout, stderr: "", timedOut: false };
  };
  ssh.hosts = hosts;
  return ssh;
}

beforeEach(() => {
  gitDouble.answer = runState();
});
afterEach(() => {
  gitDouble.answer = null;
});

// Usefulness: verifies acceptance 1, since an SSH host alias that resolves to github.com declares
// the worker PR on that repository.
test("an SSH host alias that resolves to github.com declares the PR", async () => {
  const ssh = sshDouble("host github-work\nhostname github.com\nuser git\n");

  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh,
  });

  expect(result).toEqual({ pr: 42 });
  expect(ssh.hosts).toEqual(["github-work", "github-work"]);
});

// Usefulness: verifies acceptance 2, since the same alias remote still refuses a PR in another
// repository.
test("an SSH host alias remote refuses a PR in another repository", async () => {
  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/other/repo/pull/42")]),
    ssh: sshDouble("host github-work\nhostname github.com\nuser git\n"),
  });

  expect(result).toEqual({ pr: null, reason: REASON });
});

// Usefulness: verifies a failed SSH host read keeps today's refusal and the resolver never throws.
test("a failed SSH host read keeps the literal host and refuses without a throw", async () => {
  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh: sshDouble("", { status: 255 }),
  });

  expect(result).toEqual({ pr: null, reason: REASON });
});

// Usefulness: verifies a host that starts with a dash never reaches the ssh argument list.
test("a host that starts with a dash never reaches the ssh argument list", async () => {
  gitDouble.answer = runState("git@-oProxyCommand=evil:owner/repo.git");
  const ssh = sshDouble("hostname github.com\n");

  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh,
  });

  expect(result).toEqual({ pr: null, reason: REASON });
  expect(ssh.hosts).toEqual([]);
});
