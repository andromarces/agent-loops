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

// An `ssh -G` double that answers `stdout`, and records each argument vector it receives.
function sshDouble(stdout, { status = 0 } = {}) {
  const calls = [];
  const ssh = async (args) => {
    calls.push(args);
    return { status, stdout, stderr: "", timedOut: false };
  };
  ssh.calls = calls;
  return ssh;
}

beforeEach(() => {
  gitDouble.answer = runState();
});
afterEach(() => {
  gitDouble.answer = null;
});

// Usefulness: verifies acceptance 1, since an SSH host alias that resolves to github.com declares its PR.
test("an SSH host alias that resolves to github.com declares the PR", async () => {
  const ssh = sshDouble("host github-work\nhostname github.com\nuser git\n");

  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh,
  });

  expect(result).toEqual({ pr: 42 });
  expect(ssh.calls).toEqual([
    ["-G", "-l", "git", "github-work"],
    ["-G", "-l", "git", "github-work"],
  ]);
});

// Usefulness: verifies the user reaches ssh, so a Match user alias resolves and the PR is declared.
test("the remote user reaches the ssh read", async () => {
  const calls = [];
  const ssh = async (args) => {
    calls.push(args);
    const withUser = args.includes("-l") && args[args.indexOf("-l") + 1] === "git";
    return {
      status: 0,
      stdout: withUser ? "hostname github.com\n" : "hostname github-work\n",
      stderr: "",
      timedOut: false,
    };
  };

  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh,
  });

  expect(result).toEqual({ pr: 42 });
  expect(calls).toEqual([
    ["-G", "-l", "git", "github-work"],
    ["-G", "-l", "git", "github-work"],
  ]);
});

// Usefulness: verifies a percent-encoded ssh URL user decodes to git and the PR is declared.
test("a percent-encoded ssh URL user decodes before the ssh read", async () => {
  gitDouble.answer = runState("ssh://%67it@github-work/owner/repo.git");
  const calls = [];
  const ssh = async (args) => {
    calls.push(args);
    const withUser = args.includes("-l") && args[args.indexOf("-l") + 1] === "git";
    return {
      status: 0,
      stdout: withUser ? "hostname github.com\n" : "hostname github-work\n",
      stderr: "",
      timedOut: false,
    };
  };

  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh,
  });

  expect(result).toEqual({ pr: 42 });
  expect(calls).toEqual([
    ["-G", "-l", "git", "github-work"],
    ["-G", "-l", "git", "github-work"],
  ]);
});

// Usefulness: verifies acceptance 2, since the same alias remote still refuses a PR in another repository.
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
  expect(ssh.calls).toEqual([]);
});

// Usefulness: verifies acceptance 1, since an alias that resolves to ssh.github.com declares the github.com PR.
test("an SSH host alias that resolves to ssh.github.com declares the PR", async () => {
  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh: sshDouble("host github-port\nhostname ssh.github.com\nuser git\n"),
  });

  expect(result).toEqual({ pr: 42 });
});

// Usefulness: verifies acceptance 1, since the literal ssh.github.com URL on port 443 declares the github.com PR.
test("a literal ssh URL for ssh.github.com on port 443 declares the PR", async () => {
  gitDouble.answer = runState("ssh://git@ssh.github.com:443/owner/repo.git");

  const result = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh: sshDouble("host ssh.github.com\nhostname ssh.github.com\nuser git\n"),
  });

  expect(result).toEqual({ pr: 42 });
});

// Usefulness: verifies acceptance 2, since a host that merely resembles ssh.github.com keeps its own identity.
test("a host that is not exactly ssh.github.com does not map to github.com", async () => {
  for (const host of [
    "ssh.github.example.com",
    "ssh.ghe.example.com",
    "github.example.com",
    "ssh.github.com.example.com",
    "foo.ssh.github.com",
  ]) {
    const result = await resolveWorkerPr({
      cwd: "/repo",
      head: HEAD,
      gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
      ssh: sshDouble(`hostname ${host}\n`),
    });

    expect(result, host).toEqual({ pr: null, reason: REASON });
  }
});

// Usefulness: verifies acceptance 2, since a GitHub Enterprise host matches its own PR and not github.com.
test("a GitHub Enterprise host keeps its own identity", async () => {
  gitDouble.answer = runState("git@ghe.example.com:owner/repo.git");
  const ssh = sshDouble("hostname ghe.example.com\n");

  const own = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://ghe.example.com/owner/repo/pull/42")]),
    ssh,
  });
  const github = await resolveWorkerPr({
    cwd: "/repo",
    head: HEAD,
    gh: listGh([pr("https://github.com/owner/repo/pull/42")]),
    ssh,
  });

  expect(own).toEqual({ pr: 42 });
  expect(github).toEqual({ pr: null, reason: REASON });
});
