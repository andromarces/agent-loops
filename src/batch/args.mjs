// Argument parsing and pre-write validation for `agent-loop batch` (ADR 0106).
// The runtime validates explicit values only: it reads no request and prompts for nothing.
import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { supportedAgents } from "../agents/index.mjs";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT,
  initRefusal,
  ROLE_KINDS,
  roleFlags,
} from "../lib/args.mjs";
import { canonicalPath } from "../lib/canonical-path.mjs";
import { sha256 } from "../lib/hash.mjs";
import { parseWorkTreeList } from "../lib/git-read.mjs";

const runFile = promisify(execFile);
const ROLE_FLAGS = roleFlags(ROLE_KINDS);
const PLACEHOLDERS = new Set(["issue", "title", "branch", "repo"]);
const MAX_LOOPS = 64;
const DEFAULT_SETUP_TIMEOUT = 600;

export const DEFAULT_TASK_TEMPLATE = [
  "Work on issue {issue} of {repo}.",
  "Read the issue body first, then implement the change in this work tree on branch {branch}.",
  "Commit the change on that branch, push it with `git push -u origin {branch}`, and open one",
  "pull request against the base branch whose body closes the issue with `Closes #{issue}`.",
].join("\n");

const usage = (message) => Object.assign(new Error(message), { usage: true });

function positiveInt(flag, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw usage(`${flag} must be a positive integer.`);
  }
  return number;
}

function loopCount(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_LOOPS) {
    throw usage(`--loops must be an integer from 1 to ${MAX_LOOPS}.`);
  }
  return number;
}

/** Throws a usage error for an unknown placeholder, or for a template with no {issue}. */
function validateTemplate(template) {
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    if (!PLACEHOLDERS.has(match[1])) {
      throw usage(`Unknown task placeholder: ${match[0]}.`);
    }
  }
  if (!template.includes("{issue}")) {
    throw usage("The task template must hold {issue}.");
  }
}

/**
 * Parses `agent-loop batch start` arguments. Throws an error with `usage: true` for a missing or
 * invalid value. Performs no filesystem read and writes nothing.
 * @param {string[]} argv arguments after `batch start`
 */
export function parseBatchArgs(argv) {
  const options = {
    repo: null,
    issues: [],
    base: null,
    workTreeRoot: null,
    taskTemplate: DEFAULT_TASK_TEMPLATE,
    setupCmd: null,
    setupTimeout: DEFAULT_SETUP_TIMEOUT,
    testCmd: null,
    testCmdTimeout: null,
    timeout: DEFAULT_TIMEOUT,
    reviewerSandbox: null,
    loops: null,
    maxSteps: DEFAULT_MAX_STEPS,
    mode: null,
  };
  for (const role of ROLE_KINDS) {
    options[role] = null;
    options[`${role}Model`] = null;
    options[`${role}Effort`] = null;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const read = (name) => {
      if (inline !== null) {
        if (inline === "") throw usage(`Missing value for ${name}.`);
        return inline;
      }
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw usage(`Missing value for ${name}.`);
      return value;
    };
    const readPath = (name) => resolve(read(name));

    if (Object.hasOwn(ROLE_FLAGS, flag)) {
      options[ROLE_FLAGS[flag]] = read(flag);
      continue;
    }
    switch (flag) {
      case "--repo":
        options.repo = readPath(flag);
        break;
      case "--issue": {
        const number = positiveInt(flag, read(flag));
        if (options.issues.includes(number)) throw usage(`Duplicate --issue: ${number}.`);
        options.issues.push(number);
        break;
      }
      case "--loops":
        options.loops = loopCount(read(flag));
        break;
      case "--max-steps":
        options.maxSteps = positiveInt(flag, read(flag));
        break;
      case "--base":
        options.base = read(flag);
        break;
      case "--work-tree-root":
        options.workTreeRoot = readPath(flag);
        break;
      case "--task-template":
        options.taskTemplate = read(flag);
        break;
      case "--setup-cmd":
        options.setupCmd = read(flag);
        break;
      case "--setup-timeout":
        options.setupTimeout = positiveInt(flag, read(flag));
        break;
      case "--test-cmd":
        options.testCmd = read(flag);
        break;
      case "--test-cmd-timeout":
        options.testCmdTimeout = positiveInt(flag, read(flag));
        break;
      case "--timeout": {
        const seconds = Number(read(flag));
        if (!Number.isSafeInteger(seconds) || seconds < 0) {
          throw usage("--timeout must be a non-negative integer.");
        }
        options.timeout = seconds === 0 ? null : seconds;
        break;
      }
      case "--reviewer-sandbox": {
        const value = read(flag);
        if (!["read-only", "workspace-write"].includes(value)) {
          throw usage(
            `--reviewer-sandbox must be one of read-only, workspace-write, got: ${value}`,
          );
        }
        options.reviewerSandbox = value;
        break;
      }
      case "--reviewer-workspace-write":
        if (inline !== null) throw usage("--reviewer-workspace-write does not take a value.");
        if (options.reviewerSandbox !== null && options.reviewerSandbox !== "workspace-write") {
          throw usage("--reviewer-workspace-write conflicts with --reviewer-sandbox read-only.");
        }
        options.reviewerSandbox = "workspace-write";
        break;
      default:
        throw usage(`Unknown argument: ${raw}`);
    }
  }

  if (options.repo === null) throw usage("Missing required --repo.");
  if (options.issues.length === 0) throw usage("Missing required --issue.");
  if (options.loops === null) throw usage("Missing required --loops.");
  for (const role of ROLE_KINDS) {
    if (options[role] === null) throw usage(`Missing required --${role}.`);
  }
  const refusal = initRefusal(options, {
    roles: ROLE_KINDS,
    requiredRoles: ROLE_KINDS,
    isSupportedAgent: (kind) => supportedAgents.has(kind),
    blankTaskText: null,
    rolesFirst: true,
    pathRefusal: () => null,
  });
  if (refusal) throw usage(refusal);
  validateTemplate(options.taskTemplate);
  return options;
}

async function git(args, cwd) {
  const { stdout } = await runFile("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

async function workTreeEntries(repo) {
  try {
    const stdout = await git(["worktree", "list", "--porcelain", "-z"], repo);
    return parseWorkTreeList(stdout);
  } catch (err) {
    throw usage(`--repo is not a Git work tree: ${err.message}`);
  }
}

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

async function assertWritableDirectory(path) {
  let current = path;
  for (;;) {
    try {
      const found = await stat(current);
      if (!found.isDirectory()) {
        throw usage("The work-tree root is not a directory the batch can write.");
      }
      await access(current, constants.W_OK);
      return;
    } catch (err) {
      if (err?.code === "ENOENT") {
        const parent = dirname(current);
        if (parent === current) throw err;
        current = parent;
        continue;
      }
      throw usage("The work-tree root is not a directory the batch can write.");
    }
  }
}

/**
 * Resolves the repository, base branch, and work-tree root of a batch, refusing before any state
 * write or child process exists. `id` names the default work-tree root.
 * @param {object} options parsed options
 * @param {{ gitRun?: (args: string[], cwd: string) => Promise<string> }} [deps]
 */
export async function prepareBatch(options, { gitRun = git } = {}) {
  const repo = await canonicalPath(options.repo);
  const entries = await workTreeEntries(repo);
  const first = entries[0];
  if (first === undefined || first.bare) {
    throw usage("--repo must name a Git main work tree.");
  }
  const main = await canonicalPath(first.path);
  if (main !== repo) {
    throw usage(`--repo must name the main work tree (${main}).`);
  }

  let base = options.base ?? null;
  if (base === null) {
    try {
      const remote = (
        await gitRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo)
      ).trim();
      base = remote.startsWith("origin/") ? remote.slice("origin/".length) : remote;
    } catch {
      base = "main";
    }
  }
  try {
    await gitRun(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], repo);
  } catch {
    throw usage(`--base ${base} has no refs/remotes/origin/${base}.`);
  }

  const workTreeRoot =
    options.workTreeRoot ??
    join(dirname(repo), `${basename(repo)}-batch-${options.id ?? "preview"}`);
  const rootCanonical = await canonicalPath(workTreeRoot);
  for (const entry of entries) {
    if (inside(await canonicalPath(entry.path), rootCanonical)) {
      throw usage("The work-tree root must lie outside every Git work tree.");
    }
  }
  await assertWritableDirectory(workTreeRoot);

  const repoKey = sha256(repo.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase())).slice(0, 12);
  return {
    ...options,
    repo,
    base,
    workTreeRoot: rootCanonical,
    repoKey,
    roles: Object.fromEntries(
      ROLE_KINDS.map((role) => [
        role,
        {
          kind: options[role],
          model: options[`${role}Model`],
          effort: options[`${role}Effort`],
        },
      ]),
    ),
  };
}

/** Renders the task template for one issue. */
export function renderTask(template, { issue, title, branch, repo }) {
  return template
    .replaceAll("{issue}", String(issue))
    .replaceAll("{title}", title)
    .replaceAll("{branch}", branch)
    .replaceAll("{repo}", repo);
}
