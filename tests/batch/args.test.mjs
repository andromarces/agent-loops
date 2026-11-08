import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "vite-plus/test";
import { execa } from "execa";
import { parseBatchArgs, prepareBatch } from "../../src/batch/args.mjs";
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

// Usefulness: an unknown model is refused before any state write.
test("an unknown model is a usage error", () => {
  expect(() => parseBatchArgs([...BASE, "--worker-model", "nope"])).toThrow(
    "Unsupported worker model: nope",
  );
});

// Usefulness: an unknown effort is refused before any state write.
test("an unknown effort is a usage error", () => {
  expect(() =>
    parseBatchArgs([...BASE, "--worker-model", "claude-sonnet-5-5", "--worker-effort", "extreme"]),
  ).toThrow("Unsupported worker effort: extreme");
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
  ).toThrow("Missing required --issue.");
});

// Usefulness: a duplicate issue would launch one issue twice in one batch.
test("a duplicate issue is a usage error", () => {
  expect(() => parseBatchArgs([...BASE, "--issue", "1"])).toThrow("Duplicate --issue: 1.");
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

// Usefulness: a model and effort are validated after an agent alias maps to its kind.
test("an alias still validates the model and effort", () => {
  expect(() =>
    parseBatchArgs([
      ...BASE.map((v) => (v === "agy" ? "antigravity" : v)),
      "--reviewer-effort",
      "hgh",
    ]),
  ).toThrow("Unsupported reviewer effort: hgh");
  expect(() =>
    parseBatchArgs([
      ...BASE.map((v) => (v === "agy" ? "antigravity" : v)),
      "--reviewer-model",
      "nope",
    ]),
  ).toThrow("Unsupported reviewer model: nope");
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
