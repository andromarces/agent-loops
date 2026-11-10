// Argument parsing and pre-write validation for `agent-loop batch` (ADR 0106).
// The runtime validates explicit values only: it reads no request and prompts for nothing.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, constants, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { supportedAgents } from "../agents/index.mjs";
import { normalizeAgent } from "../lib/agent-kinds.mjs";
import { DEFAULT_TIMEOUT, initRefusal, ROLE_KINDS, roleFlags } from "../lib/args.mjs";
import { canonicalPath } from "../lib/canonical-path.mjs";
import { sha256 } from "../lib/hash.mjs";
import { parseWorkTreeList } from "../lib/git-read.mjs";
import { normalizeItems } from "./items.mjs";

const runFile = promisify(execFile);
const ROLE_FLAGS = roleFlags(ROLE_KINDS);
const PLACEHOLDERS = new Set(["issue", "title", "branch", "repo"]);
const MAX_LOOPS = 64;
const DEFAULT_SETUP_TIMEOUT = 600;

// The model and effort values that a supported CLI accepts. The adapters pass these through, so a
// value outside the set is a usage error before any child exists.
const MODEL_PATTERNS = {
  claude: /^(?:claude-|opus$|sonnet$|haiku$)/i,
  codex: /^(?:gpt-|o\d|codex)/i,
  copilot: /^(?:gpt-|claude-|o\d|gemini-|opus$|sonnet$|haiku$)/i,
  agy: /^gemini-/i,
  opencode: /^[^\s/]+\/\S+$/,
};
const EFFORTS = {
  claude: new Set(["low", "medium", "high", "max"]),
  codex: new Set(["minimal", "low", "medium", "high", "xhigh"]),
  copilot: new Set(["low", "medium", "high"]),
  agy: new Set(["low", "medium", "high"]),
};

export const DEFAULT_TASK_TEMPLATE = [
  "Work on issue {issue} of {repo}.",
  "Read the issue body first, then implement the change in this work tree on branch {branch}.",
  "Commit the change on that branch, push it with `git push -u origin {branch}`, and open one",
  "pull request against the base branch whose body closes the issue with `Closes #{issue}`.",
].join("\n");

export const DEFAULT_PR_TASK_TEMPLATE = [
  "Review pull request {issue} of {repo} in this work tree on branch {branch}.",
  "The work tree holds the pull request head. In work-first or review-first, commit any worker",
  "correction on the same branch and push it with `git push -u origin {branch}`.",
  "In review-only, change nothing and finish after the reviewer turn.",
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

/** Throws a usage error for an unknown placeholder, or for a template with no {issue} when required. */
function validateTemplate(template, { requireIssue = true } = {}) {
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    if (!PLACEHOLDERS.has(match[1])) {
      throw usage(`Unknown task placeholder: ${match[0]}.`);
    }
  }
  if (requireIssue && !template.includes("{issue}")) {
    throw usage("The task template must hold {issue}.");
  }
}

/**
 * Parses `agent-loop batch start` arguments. Throws an error with `usage: true` for a missing or
 * invalid value. Performs no filesystem read except the explicit `--items-file`, and writes nothing.
 * @param {string[]} argv arguments after `batch start`
 */
export function parseBatchArgs(argv) {
  const options = {
    repo: null,
    issues: [],
    items: null,
    itemsFile: null,
    fromAudit: null,
    base: null,
    workTreeRoot: null,
    taskTemplate: DEFAULT_TASK_TEMPLATE,
    requireSpecification: false,
    setupCmd: null,
    setupTimeout: DEFAULT_SETUP_TIMEOUT,
    testCmd: null,
    testCmdTimeout: null,
    timeout: DEFAULT_TIMEOUT,
    reviewerSandbox: null,
    loops: null,
    maxSteps: null,
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
    if (flag === "--help" || flag === "-h") {
      return { help: true };
    }
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
      case "--items-file":
        options.itemsFile = readPath(flag);
        break;
      case "--require-specification":
        if (inline !== null) throw usage("--require-specification does not take a value.");
        options.requireSpecification = true;
        break;
      case "--from-audit":
        options.fromAudit = read(flag);
        break;
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
        setReviewerSandbox(options, value, false);
        break;
      }
      case "--reviewer-workspace-write":
        if (inline !== null) throw usage("--reviewer-workspace-write does not take a value.");
        setReviewerSandbox(options, "workspace-write", true);
        break;
      default:
        throw usage(`Unknown argument: ${raw}`);
    }
  }

  if (options.repo === null) throw usage("Missing required --repo.");
  if (options.fromAudit !== null && options.issues.length > 0) {
    throw usage("--from-audit cannot be combined with --issue.");
  }
  if (options.fromAudit !== null && options.itemsFile !== null) {
    throw usage("--from-audit cannot be combined with --items-file.");
  }
  if (options.fromAudit === null && options.issues.length > 0 && options.itemsFile !== null) {
    throw usage("--items-file cannot be combined with --issue.");
  }
  if (options.fromAudit === null && options.issues.length === 0 && options.itemsFile === null) {
    throw usage("Missing required --issue, --from-audit, or --items-file.");
  }
  if (options.itemsFile !== null) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(options.itemsFile, "utf8"));
    } catch (err) {
      throw usage(`The items file is unreadable: ${err.message}`);
    }
    try {
      options.items = normalizeItems(raw);
    } catch (err) {
      throw usage(err.message);
    }
    options.issues = options.items.map((item) => item.key);
  }
  if (options.loops === null) throw usage("Missing required --loops.");
  if (options.maxSteps === null) throw usage("Missing required --max-steps.");
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
  const roleRefusal = roleOptionRefusal(options);
  if (roleRefusal) throw usage(roleRefusal);
  const needsIssuePlaceholder =
    options.itemsFile === null ||
    (options.items ?? []).some((item) => item.kind === "issue" && item.task === null);
  validateTemplate(options.taskTemplate, { requireIssue: needsIssuePlaceholder });
  return options;
}

// The parsed option objects that used the `--reviewer-workspace-write` alias, for the conflict text.
const aliasUsers = new WeakSet();

function setReviewerSandbox(options, value, viaAlias) {
  const earlier = options.reviewerSandbox;
  if (earlier !== null && earlier !== value) {
    const alias = viaAlias || aliasUsers.has(options);
    const shown = viaAlias ? earlier : value;
    throw usage(
      alias
        ? `--reviewer-workspace-write conflicts with --reviewer-sandbox ${shown}.`
        : `--reviewer-sandbox ${value} conflicts with --reviewer-sandbox ${earlier}.`,
    );
  }
  if (viaAlias) aliasUsers.add(options);
  options.reviewerSandbox = value;
}

/** The refusal for one configured role's model or effort, or null. */
export function roleOptionRefusalFor(role, kind, model, effort) {
  const normalized = kind === null ? null : normalizeAgent(kind);
  if (normalized === null) return null;
  if (model !== null && !(MODEL_PATTERNS[normalized]?.test(model) ?? true)) {
    return `Unsupported ${role} model: ${model}`;
  }
  const allowed = EFFORTS[normalized];
  if (effort !== null && allowed !== undefined && !allowed.has(effort)) {
    return `Unsupported ${role} effort: ${effort}`;
  }
  return null;
}

/** The first unsupported model or effort of a configured role, or null. */
function roleOptionRefusal(options) {
  for (const role of ROLE_KINDS) {
    const refusal = roleOptionRefusalFor(
      role,
      options[role],
      options[`${role}Model`],
      options[`${role}Effort`],
    );
    if (refusal) return refusal;
  }
  return null;
}

/**
 * The canonical path of `path`, resolving the nearest existing ancestor through the real path and
 * keeping the missing tail. A root reached through a directory link is therefore compared against
 * the real work tree, never against the alias spelling.
 */
export async function canonicalWritePath(path) {
  let current = resolve(path);
  const tail = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return join(real, ...tail.reverse());
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** The nearest existing directory at or above `path`. */
export async function nearestExistingDirectory(path) {
  let current = resolve(path);
  for (;;) {
    try {
      const found = await stat(current);
      return found.isDirectory() ? current : dirname(current);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Refuses a runs root that lies inside any Git work tree (ADR 0106 decision 8). */
export async function refuseRunsRootInGitWorkTree(runsRoot, { gitRun = git } = {}) {
  const candidate = await canonicalWritePath(runsRoot);
  const top = await gitWorkTreeTop(candidate, gitRun);
  if (top !== null && inside(top, candidate)) {
    throw usage("The runs root must lie outside every Git work tree.");
  }
}

// The work-tree top of the nearest existing ancestor of `candidate`, or null. A `.git` entry in
// any ancestor counts even when the Git read fails.
async function gitWorkTreeTop(candidate, gitRun) {
  const ancestor = await nearestExistingDirectory(candidate);
  try {
    const top = (await gitRun(["rev-parse", "--show-toplevel"], ancestor)).trim();
    if (top !== "") return canonicalPath(top);
  } catch {
    // Fall through to the `.git` entry scan.
  }
  let current = ancestor;
  for (;;) {
    try {
      await stat(join(current, ".git"));
      return canonicalPath(current);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Refuses a work-tree root inside any Git work tree, not only the target repository. */
export async function refuseWorkTreeRootInGitWorkTree(workTreeRoot, { gitRun = git } = {}) {
  const candidate = await canonicalWritePath(workTreeRoot);
  const top = await gitWorkTreeTop(candidate, gitRun);
  if (top !== null && inside(top, candidate)) {
    throw usage("The work-tree root must lie outside every Git work tree.");
  }
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
  const rootCanonical = await canonicalWritePath(workTreeRoot);
  await refuseWorkTreeRootInGitWorkTree(rootCanonical, { gitRun });
  await assertWritableDirectory(rootCanonical);

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
