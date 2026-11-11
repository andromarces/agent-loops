import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, expect, test, vi } from "vite-plus/test";
import { parseAuditArgs, prepareAudit } from "../../src/batch/audit-args.mjs";
import { git } from "../../src/batch/git.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

const roots = [];
const repos = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await removePath(root);
  for (const repo of repos.splice(0)) await removePath(repo);
});

/** Runs `parse`, then returns the stderr lines it logged. */
function warningsFrom(parse) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    parse();
    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}

// Usefulness: a refusal before the store exists is a usage error, not a partial audit.
test("audit arguments require two reviewers and one worker", () => {
  const base = ["--repo", ".", "--reviewer", "claude", "--reviewer", "agy", "--worker", "codex"];
  expect(parseAuditArgs(base).reviewers).toHaveLength(2);
  expect(() =>
    parseAuditArgs(["--repo", ".", "--reviewer", "claude", "--worker", "codex"]),
  ).toThrow("At least two --reviewer entries are required.");
  expect(() =>
    parseAuditArgs(["--repo", ".", "--reviewer", "claude", "--reviewer", "agy"]),
  ).toThrow("Missing required --worker.");
  expect(warningsFrom(() => parseAuditArgs([...base, "--reviewer-model", "x"]))).toEqual([
    expect.stringContaining("Unknown reviewer model: x"),
  ]);
  expect(() => parseAuditArgs(["--repo", ".", "--reviewer-model", "x"])).toThrow(
    "--reviewer-model requires a preceding --reviewer.",
  );
  expect(() => parseAuditArgs([...base, "--reviewer-sandbox", "read-only"])).toThrow(
    "--reviewer-sandbox requires every --reviewer to be codex.",
  );
  expect(() =>
    parseAuditArgs([
      "--repo",
      ".",
      "--reviewer",
      "claude",
      "--reviewer",
      "claude",
      "--worker",
      "codex",
    ]),
  ).toThrow("Duplicate reviewer settings: claude.");
});

// Usefulness: an inline value on the sandbox alias is refused before the sandbox conflict.
test("an inline value on the sandbox alias wins over a conflict", () => {
  const base = ["--repo", ".", "--reviewer", "codex", "--reviewer", "codex", "--worker", "codex"];
  expect(() =>
    parseAuditArgs([...base, "--reviewer-sandbox", "read-only", "--reviewer-workspace-write=true"]),
  ).toThrow("--reviewer-workspace-write does not take a value.");
});

// Usefulness: the operator focus is one text source.
// A blank text cannot become a reviewer goal, so the refusal happens before a store, work tree,
// or child exists (issue #1750).
test("focus flags are mutually exclusive and refuse blank text", () => {
  const base = ["--repo", ".", "--reviewer", "claude", "--reviewer", "agy", "--worker", "codex"];
  expect(parseAuditArgs([...base, "--focus", "check cleanup"]).focus).toBe("check cleanup");
  expect(parseAuditArgs([...base, "--focus-file", "focus.txt"]).focusFile).toBe("focus.txt");
  expect(() => parseAuditArgs([...base, "--focus", "a", "--focus-file", "focus.txt"])).toThrow(
    "--focus and --focus-file cannot be combined.",
  );
  expect(() => parseAuditArgs([...base, "--focus", "   "])).toThrow("--focus must not be empty.");
});

// Usefulness: a focus file that holds no text gives the reviewers no goal.
// The start is refused before any store, work tree, or child exists (issue #1750).
test("a blank focus file is refused and a file supplies the focus text", async () => {
  const main = await createTempRepo();
  repos.push(main);
  const remote = `${main}-remote`;
  repos.push(remote);
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).stdout;
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["remote", "add", "origin", remote], { cwd: main });
  await execa("git", ["push", "-u", "origin", base], { cwd: main });
  await execa("git", ["update-ref", `refs/remotes/origin/${base}`, "HEAD"], { cwd: main });
  const dir = await mkdtemp(join(tmpdir(), "audit-focus-"));
  roots.push(dir);
  const blank = join(dir, "blank.txt");
  await writeFile(blank, " \n\t\n");
  const full = join(dir, "focus.txt");
  await writeFile(full, "Check outdated direct dependencies\n");
  const options = {
    id: "20260101-000000-test",
    repo: main,
    reviewers: [
      { kind: "claude", model: null, effort: null },
      { kind: "agy", model: null, effort: null },
    ],
    worker: "codex",
    workerModel: null,
    workerEffort: null,
    base,
    workTreeRoot: dir,
    setupCmd: null,
    setupTimeout: 600,
    timeout: null,
    reviewerSandbox: null,
    focus: null,
    focusFile: blank,
  };

  await expect(prepareAudit(options)).rejects.toThrow("--focus-file must not be empty.");

  const prepared = await prepareAudit({ ...options, focusFile: full });
  expect(prepared.focus).toBe("Check outdated direct dependencies");
});

// Usefulness: the default runner returns an object, so prepareAudit must read its stdout to refuse (issue #1758).
test("prepareAudit refuses a work-tree root inside a Git work tree through the rev-parse answer", async () => {
  const top = await mkdtemp(join(tmpdir(), "audit-git-top-"));
  roots.push(top);
  const repo = await mkdtemp(join(tmpdir(), "audit-git-repo-"));
  roots.push(repo);
  const workTreeRoot = join(top, "nested");
  await mkdir(workTreeRoot);
  const gitRun = async (args) => {
    const result = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (args[0] === "worktree") return { ...result, stdout: `worktree ${repo}\0` };
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { ...result, stdout: top };
    }
    if (args[0] === "rev-parse") return { ...result, stdout: "abc123" };
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  await expect(
    prepareAudit(
      {
        id: "20260101-000000-test",
        repo,
        reviewers: [
          { kind: "claude", model: null, effort: null },
          { kind: "agy", model: null, effort: null },
        ],
        worker: "codex",
        workerModel: null,
        workerEffort: null,
        base: "main",
        workTreeRoot,
        setupCmd: null,
        setupTimeout: 600,
        timeout: null,
        reviewerSandbox: null,
      },
      { gitRun },
    ),
  ).rejects.toThrow("The work-tree root must lie outside every Git work tree.");
});

// Usefulness: the audit freezes one revision.
// It refuses a base that has no remote ref, so no reviewer can audit a moving branch.
test("prepare resolves the frozen revision and refuses a missing base", async () => {
  const main = await createTempRepo();
  repos.push(main);
  const remote = `${main}-remote`;
  repos.push(remote);
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).stdout;
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["remote", "add", "origin", remote], { cwd: main });
  await execa("git", ["push", "-u", "origin", base], { cwd: main });
  await execa("git", ["update-ref", `refs/remotes/origin/${base}`, "HEAD"], { cwd: main });
  await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${base}`], {
    cwd: main,
  });
  const head = (await git(["rev-parse", "HEAD"], main)).stdout;
  const root = await mkdtemp(join(tmpdir(), "audit-root-"));
  roots.push(root);
  const prepared = await prepareAudit({
    id: "20260101-000000-test",
    repo: main,
    reviewers: [
      { kind: "claude", model: null, effort: null },
      { kind: "agy", model: null, effort: null },
    ],
    worker: "codex",
    workerModel: null,
    workerEffort: null,
    base,
    workTreeRoot: root,
    setupCmd: null,
    setupTimeout: 600,
    timeout: null,
    reviewerSandbox: null,
  });
  expect(prepared.revision).toBe(head);
  await expect(
    prepareAudit({
      id: "20260101-000000-test",
      repo: main,
      reviewers: [
        { kind: "claude", model: null, effort: null },
        { kind: "agy", model: null, effort: null },
      ],
      worker: "codex",
      workerModel: null,
      workerEffort: null,
      base: "no-such-base",
      workTreeRoot: root,
      setupCmd: null,
      setupTimeout: 600,
      timeout: null,
      reviewerSandbox: null,
    }),
  ).rejects.toThrow(/has no refs\/remotes\/origin\/no-such-base/);
});

// Usefulness: a repeated worker flag with a different value is refused, not silently overwritten.
test("a repeated worker flag with a conflicting value is a usage error", () => {
  expect(() =>
    parseAuditArgs([
      "--repo",
      ".",
      "--reviewer",
      "claude",
      "--reviewer",
      "agy",
      "--worker",
      "codex",
      "--worker",
      "claude",
    ]),
  ).toThrow("--worker conflicts with an earlier value.");
});
