import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, test, vi } from "vite-plus/test";
import { execa } from "execa";
import {
  assertWritableDirectory,
  parseBatchArgs,
  prepareBatch,
  refuseRootInGitWorkTree,
} from "../../src/batch/args.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { canonicalPath } from "../../src/lib/canonical-path.mjs";

const BASE = [
  "--repo",
  "REPO",
  "--issue",
  "1",
  "--orchestrator",
  "codex",
  "--worker",
  "claude",
  "--reviewer",
  "agy",
  "--loops",
  "2",
  "--max-steps",
  "10",
];

function args(overrides = {}) {
  const options = {
    repo: "REPO",
    issues: [1],
    orchestrator: "codex",
    worker: "claude",
    reviewer: "agy",
    loops: 2,
    maxSteps: 10,
  };
  return { ...options, ...overrides };
}

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

// Usefulness: a missing --loops is the owner decision that keeps the count required.
test("missing --loops is a usage error", () => {
  expect(() =>
    parseBatchArgs(BASE.filter((value) => value !== "--loops" && value !== "2")),
  ).toThrow("Missing required --loops.");
});

// Usefulness: the accepted loop range is 1 to 64.
test("a loop count outside 1 to 64 is a usage error", () => {
  expect(() => parseBatchArgs([...BASE].map((v) => (v === "2" ? "0" : v)))).toThrow(
    "--loops must be an integer from 1 to 64.",
  );
  expect(() => parseBatchArgs([...BASE].map((v) => (v === "2" ? "65" : v)))).toThrow(
    "--loops must be an integer from 1 to 64.",
  );
});

// Usefulness: a bad step budget is refused before any store or child exists.
test("an invalid --max-steps is a usage error", () => {
  expect(() => parseBatchArgs([...BASE].map((v) => (v === "10" ? "0" : v)))).toThrow(
    "--max-steps must be a positive integer.",
  );
});

// Usefulness: --max-steps is required, so a missing budget is never defaulted silently.
test("missing --max-steps is a usage error", () => {
  expect(() =>
    parseBatchArgs(BASE.filter((value) => value !== "--max-steps" && value !== "10")),
  ).toThrow("Missing required --max-steps.");
});

// Usefulness: every newly accepted model and effort value parses with no warning.
test("the newly accepted model and effort values parse with no warning", () => {
  const cases = [
    ["claude", "--worker-model", "fable"],
    ["claude", "--worker-effort", "xhigh"],
    ["copilot", "--worker-model", "auto"],
    ["copilot", "--worker-effort", "none"],
    ["copilot", "--worker-effort", "minimal"],
    ["copilot", "--worker-effort", "xhigh"],
    ["copilot", "--worker-effort", "max"],
    ["agy", "--worker-effort", "xhigh"],
    ["agy", "--worker-effort", "max"],
  ];
  for (const [worker, flag, value] of cases) {
    const warnings = warningsFrom(() =>
      parseBatchArgs([...BASE.map((v) => (v === "claude" ? worker : v)), flag, value]),
    );
    expect(warnings).toEqual([]);
  }
});

// Usefulness: an unknown model is accepted with one warning, and the CLI decides the value.
test("an unknown model logs one warning", () => {
  const warnings = warningsFrom(() => parseBatchArgs([...BASE, "--worker-model", "nope"]));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Unknown worker model: nope");
});

// Usefulness: an unknown effort is accepted with one warning, and the CLI decides the value.
test("an unknown effort logs one warning", () => {
  const warnings = warningsFrom(() =>
    parseBatchArgs([...BASE, "--worker-model", "claude-sonnet-5-5", "--worker-effort", "extreme"]),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Unknown worker effort: extreme");
});

// Usefulness: two sandbox flags that disagree are a conflict, never a silent last value.
test("conflicting sandbox flags are refused in both orders", () => {
  const codex = BASE.map((value) => (value === "agy" ? "codex" : value));
  expect(() =>
    parseBatchArgs([
      ...codex,
      "--reviewer-sandbox",
      "read-only",
      "--reviewer-sandbox",
      "workspace-write",
    ]),
  ).toThrow("--reviewer-sandbox workspace-write conflicts with --reviewer-sandbox read-only.");
  expect(() =>
    parseBatchArgs([...codex, "--reviewer-workspace-write", "--reviewer-sandbox", "read-only"]),
  ).toThrow("--reviewer-workspace-write conflicts with --reviewer-sandbox read-only.");
});

// Usefulness: an inline value on the sandbox alias is refused before the sandbox conflict.
test("an inline value on the sandbox alias wins over a conflict", () => {
  const codex = BASE.map((value) => (value === "agy" ? "codex" : value));
  expect(() =>
    parseBatchArgs([
      ...codex,
      "--reviewer-sandbox",
      "read-only",
      "--reviewer-workspace-write=true",
    ]),
  ).toThrow("--reviewer-workspace-write does not take a value.");
});

// Usefulness: an unsupported agent is refused with the headless wording.
test("an unknown agent is a usage error", () => {
  expect(() => parseBatchArgs([...BASE].map((v) => (v === "agy" ? "nope" : v)))).toThrow(
    "Unsupported reviewer: nope",
  );
});

// Usefulness: an effort without a model is refused by the shared role parser.
test("an effort without a model is a usage error", () => {
  expect(() =>
    parseBatchArgs([
      ...BASE.map((v) => (v === "claude" ? "opencode" : v)),
      "--worker-effort",
      "high",
    ]),
  ).toThrow("--worker-effort requires --worker-model for opencode.");
});

// Usefulness: the runtime selects no issue, so an empty set is refused.
test("an empty selection is a usage error", () => {
  expect(() =>
    parseBatchArgs(BASE.filter((value, i) => value !== "--issue" && BASE[i - 1] !== "--issue")),
  ).toThrow("Missing required --issue, --from-audit, or --items-file.");
});

// Usefulness: a duplicate issue would launch one issue twice in one batch.
test("a duplicate issue is a usage error", () => {
  expect(() => parseBatchArgs([...BASE, "--issue", "1"])).toThrow("Duplicate --issue: 1.");
});

// Usefulness: an audit id supplies the whole selection, so no explicit --issue is required.
test("--from-audit replaces the required --issue list", () => {
  const options = parseBatchArgs([
    ...BASE.filter((value, i) => value !== "--issue" && BASE[i - 1] !== "--issue"),
    "--from-audit",
    "20260101-000000-abcd1234",
  ]);
  expect(options.fromAudit).toBe("20260101-000000-abcd1234");
  expect(options.issues).toEqual([]);
});

// Usefulness: a frozen audit set and explicit issues in one command mix two selections.
test("--from-audit and --issue are mutually exclusive", () => {
  expect(() => parseBatchArgs([...BASE, "--from-audit", "20260101-000000-abcd1234"])).toThrow(
    "--from-audit cannot be combined with --issue.",
  );
});

// Usefulness: an unknown placeholder would render literal text into a child task.
test("an unknown task placeholder is a usage error", () => {
  expect(() => parseBatchArgs([...BASE, "--task-template", "Do {issue} for {owner}"])).toThrow(
    "Unknown task placeholder: {owner}.",
  );
});

// Usefulness: a template without {issue} cannot identify the work.
test("a task template without {issue} is a usage error", () => {
  expect(() => parseBatchArgs([...BASE, "--task-template", "Do {title}"])).toThrow(
    "The task template must hold {issue}.",
  );
});

// Usefulness: the CLI accepts every documented setting and records the default template.
test("every documented setting parses", () => {
  const options = parseBatchArgs([
    ...BASE.map((v) => (v === "agy" ? "codex" : v)),
    "--base",
    "main",
    "--work-tree-root",
    "/tmp/batch-root",
    "--task-template",
    "{issue} {title} {branch} {repo}",
    "--setup-cmd",
    "pnpm install",
    "--setup-timeout",
    "60",
    "--test-cmd",
    "pnpm test",
    "--test-cmd-timeout",
    "120",
    "--timeout",
    "60",
    "--reviewer-sandbox",
    "read-only",
    "--worker-model",
    "claude-sonnet-5-5",
    "--worker-effort",
    "high",
    "--orchestrator-model",
    "gpt-5",
    "--reviewer-effort",
    "low",
  ]);
  expect(options.loops).toBe(2);
  expect(options.maxSteps).toBe(10);
  expect(options.taskTemplate).toBe("{issue} {title} {branch} {repo}");
  expect(options.workerModel).toBe("claude-sonnet-5-5");
  expect(options.reviewerSandbox).toBe("read-only");
});

// Usefulness: the default template names the issue, the branch push, and the closing PR.
test("the default task template names the delivery commands", () => {
  const options = parseBatchArgs(BASE);
  expect(options.taskTemplate).toContain("{issue}");
  expect(options.taskTemplate).toContain("git push -u origin {branch}");
  expect(options.taskTemplate).toContain("Closes #{issue}");
});

// Usefulness: --repo must name the main work tree, and the refusal names it.
test("a linked work tree as --repo is refused with the main work tree", async () => {
  const { base, main } = await sharedBatchRepo();
  await expect(prepareBatch(args({ repo: base }), {})).rejects.toThrow(
    `--repo must name the main work tree (${await canonicalPath(main)}).`,
  );
});

// Usefulness: a work-tree root inside any Git work tree would put batch state in a reviewed tree.
test("a work-tree root inside a Git work tree is refused", async () => {
  const { main } = await sharedBatchRepo();
  await expect(
    prepareBatch(args({ repo: main, workTreeRoot: join(main, "nested") }), {}),
  ).rejects.toThrow("The work-tree root must lie outside every Git work tree.");
});

// One immutable repository for the file. Each case only reads it, so no case runs git init or a
// worktree registration of its own.
let sharedRepoPromise;
function sharedBatchRepo() {
  sharedRepoPromise ??= (async () => {
    const main = await createTempRepo();
    // One remote default branch, so the base check resolves.
    await execa("git", ["remote", "add", "origin", main], { cwd: main });
    await execa("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: main });
    await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
      cwd: main,
    });
    const linked = `${main}-linked`;
    await execa("git", ["worktree", "add", "-b", "batch-check", linked], { cwd: main });
    await mkdir(join(main, "docs"), { recursive: true });
    await writeFile(join(main, "docs", "keep.txt"), "keep" + String.fromCharCode(10));
    return { base: linked, main };
  })();
  return sharedRepoPromise;
}

afterAll(async () => {
  const repo = await sharedRepoPromise;
  if (repo) {
    await removePath(repo.base);
    await removePath(repo.main);
    sharedRepoPromise = undefined;
  }
});

// Usefulness: a work-tree root reached through a directory link is still inside the work tree.
test("a work-tree root under a linked alias of the work tree is refused", async () => {
  const { main } = await sharedBatchRepo();
  const aliasParent = await mkdtemp(join(tmpdir(), "batch-alias-"));
  const alias = join(aliasParent, "alias");
  try {
    await symlink(main, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(
      prepareBatch(args({ repo: main, workTreeRoot: join(alias, "nested") }), {}),
    ).rejects.toThrow("The work-tree root must lie outside every Git work tree.");
  } finally {
    await removePath(aliasParent);
  }
});

// Usefulness: a model and effort warning resolves the agent alias to its kind.
test("an alias still warns on the model and effort", () => {
  const aliasBase = BASE.map((v) => (v === "agy" ? "antigravity" : v));
  const effortWarnings = warningsFrom(() =>
    parseBatchArgs([...aliasBase, "--reviewer-effort", "hgh"]),
  );
  expect(effortWarnings).toEqual([expect.stringContaining("Unknown reviewer effort: hgh")]);
  const modelWarnings = warningsFrom(() =>
    parseBatchArgs([...aliasBase, "--reviewer-model", "nope"]),
  );
  expect(modelWarnings).toEqual([expect.stringContaining("Unknown reviewer model: nope")]);
});

// Usefulness: a work-tree root inside any repository, not only the target, is refused.
test("a work-tree root inside another Git work tree is refused", async () => {
  const repo = await sharedBatchRepo();
  const other = await createTempRepo();
  try {
    await expect(
      prepareBatch(args({ repo: repo.main, workTreeRoot: join(other, "nested") }), {}),
    ).rejects.toThrow("The work-tree root must lie outside every Git work tree.");
  } finally {
    await removePath(other);
  }
});

// Usefulness: the merged refusal keeps the runs-root text, so a user reads which root is refused.
test("the merged refusal names the runs root", async () => {
  const { main } = await sharedBatchRepo();
  await expect(refuseRootInGitWorkTree(join(main, "runs"), "runs root")).rejects.toThrow(
    "The runs root must lie outside every Git work tree.",
  );
});

// Usefulness: the merged ancestor walk still refuses an existing file as the work-tree root.
test("a file as the work-tree root is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batch-root-file-"));
  const file = join(dir, "root.txt");
  await writeFile(file, "x");
  try {
    await expect(assertWritableDirectory(file, "batch")).rejects.toThrow(
      "The work-tree root is not a directory the batch can write.",
    );
  } finally {
    await removePath(dir);
  }
});
