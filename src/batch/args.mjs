// Argument parsing and pre-write validation for `agent-loop batch` (ADR 0106).
// The runtime validates explicit values only: it reads no request and prompts for nothing.
import { readFileSync } from "node:fs";
import { access, constants, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { supportedAgents } from "../agents/index.mjs";
import { normalizeAgent } from "../lib/agent-kinds.mjs";
import {
  DEFAULT_TIMEOUT,
  initRefusal,
  ROLE_KINDS,
  roleFlags,
  STOP_FLAG_WALK,
  walkFlags,
} from "../lib/args.mjs";
import { canonicalPath, isInside } from "../lib/canonical-path.mjs";
import { sha256 } from "../lib/hash.mjs";
import { parseWorkTreeList } from "../lib/git-read.mjs";
import { logWarn } from "../lib/log.mjs";
import { gitOrThrow } from "./git.mjs";
import { normalizeItems } from "./items.mjs";

const ROLE_FLAGS = roleFlags(ROLE_KINDS);
const PLACEHOLDERS = new Set(["issue", "title", "branch", "repo"]);
const MAX_LOOPS = 64;
const DEFAULT_SETUP_TIMEOUT = 600;

// The model and effort values that a supported CLI accepts. The adapters pass these through, so a
// value outside the set logs a warning. The agent CLI refuses a bad value at launch.
const MODEL_PATTERNS = {
  claude: /^(?:claude-|opus$|sonnet$|haiku$|fable$)/i,
  codex: /^(?:gpt-|o\d|codex)/i,
  copilot: /^(?:gpt-|claude-|o\d|gemini-|opus$|sonnet$|haiku$|auto$)/i,
  agy: /^gemini-/i,
  opencode: /^[^\s/]+\/\S+$/,
};
const EFFORTS = {
  claude: new Set(["low", "medium", "high", "xhigh", "max"]),
  codex: new Set(["minimal", "low", "medium", "high", "xhigh"]),
  copilot: new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  agy: new Set(["low", "medium", "high", "xhigh", "max"]),
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

/** A usage error, so the CLI exits with code 2. */
export const usage = (message) => Object.assign(new Error(message), { usage: true });

/** The flag value as a positive integer, or a usage error. */
export function positiveInt(flag, value) {
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
 * invalid value. An unknown model or effort logs one warning. Performs no filesystem read except
 * the explicit `--items-file`, and writes nothing.
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

  let help = false;
  walkFlags(
    argv,
    0,
    (flag, read, inline) => {
      if (flag === "--help" || flag === "-h") {
        help = true;
        return STOP_FLAG_WALK;
      }
      const readPath = (name) => resolve(read(name));
      if (Object.hasOwn(ROLE_FLAGS, flag)) {
        options[ROLE_FLAGS[flag]] = read(flag);
        return true;
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
          return false;
      }
      return true;
    },
    { error: usage, allowInlineOnStop: true },
  );
  if (help) return { help: true };

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
  const logged = new Set();
  for (const role of ROLE_KINDS) {
    logRoleOptionWarnings(
      role,
      options[role],
      options[`${role}Model`],
      options[`${role}Effort`],
      logged,
    );
  }
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

/**
 * The warnings for one configured role's unknown model or effort values, in that order. The agent
 * CLI refuses a bad value at launch.
 */
function roleOptionWarningsFor(role, kind, model, effort) {
  const normalized = kind === null ? null : normalizeAgent(kind);
  if (normalized === null) return [];
  const warnings = [];
  if (model !== null && !(MODEL_PATTERNS[normalized]?.test(model) ?? true)) {
    warnings.push(`Unknown ${role} model: ${model}. The agent CLI refuses a bad value at launch.`);
  }
  const allowed = EFFORTS[normalized];
  if (effort !== null && allowed !== undefined && !allowed.has(effort)) {
    warnings.push(
      `Unknown ${role} effort: ${effort}. The agent CLI refuses a bad value at launch.`,
    );
  }
  return warnings;
}

/** Logs each warning for one configured role once, skipping a text that `logged` holds. */
export function logRoleOptionWarnings(role, kind, model, effort, logged) {
  for (const warning of roleOptionWarningsFor(role, kind, model, effort)) {
    if (logged.has(warning)) continue;
    logged.add(warning);
    logWarn(warning);
  }
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
async function nearestExistingDirectory(path) {
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
export async function refuseRunsRootInGitWorkTree(runsRoot, { gitRun = gitOrThrow } = {}) {
  const candidate = await canonicalWritePath(runsRoot);
  const top = await gitWorkTreeTop(candidate, gitRun);
  if (top !== null && isInside(top, candidate)) {
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
export async function refuseWorkTreeRootInGitWorkTree(workTreeRoot, { gitRun = gitOrThrow } = {}) {
  const candidate = await canonicalWritePath(workTreeRoot);
  const top = await gitWorkTreeTop(candidate, gitRun);
  if (top !== null && isInside(top, candidate)) {
    throw usage("The work-tree root must lie outside every Git work tree.");
  }
}

async function workTreeEntries(repo) {
  try {
    const stdout = await gitOrThrow(["worktree", "list", "--porcelain", "-z"], repo);
    return parseWorkTreeList(stdout);
  } catch (err) {
    throw usage(`--repo is not a Git work tree: ${err.message}`);
  }
}

/**
 * Refuses a work-tree root that is not a writable directory, naming the `noun` that writes it.
 * A missing path is checked at its nearest existing ancestor.
 * `rootError` selects the batch rethrow or the audit usage refusal at a filesystem root.
 */
export async function assertWritableDirectory(path, noun, { rootError = "usage" } = {}) {
  const refusal = `The work-tree root is not a directory the ${noun} can write.`;
  let current = path;
  for (;;) {
    try {
      const found = await stat(current);
      if (!found.isDirectory()) throw usage(refusal);
      await access(current, constants.W_OK);
      return;
    } catch (err) {
      if (err?.usage && rootError !== "throw") throw err;
      if (err?.code !== "ENOENT") throw usage(refusal);
      const parent = dirname(current);
      if (parent === current) {
        if (rootError === "throw") throw err;
        throw usage(refusal);
      }
      current = parent;
    }
  }
}

/** The stable short key of a repository path, with a Windows drive letter in lower case. */
export function repoKey(repo) {
  return sha256(repo.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase())).slice(0, 12);
}

/**
 * Resolves the main work tree, base branch, base revision, work-tree root, and key shared by a
 * batch and an audit. `readText` returns stdout, and `gitRun` runs the work-tree-root check. Both
 * keep each caller's runner.
 */
export async function prepareRepository({
  options,
  repo,
  entries,
  readText,
  gitRun,
  noun,
  defaultRoot,
  rootError = "usage",
}) {
  const first = entries[0];
  if (first === undefined || first.bare) throw usage("--repo must name a Git main work tree.");
  const main = await canonicalPath(first.path);
  if (main !== repo) throw usage(`--repo must name the main work tree (${main}).`);

  let base = options.base ?? null;
  if (base === null) {
    try {
      const remote = (
        await readText(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo)
      ).trim();
      base = remote.startsWith("origin/") ? remote.slice("origin/".length) : remote;
    } catch {
      base = "main";
    }
  }
  let revision = null;
  try {
    revision = await readText(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`],
      repo,
    );
  } catch {
    throw usage(`--base ${base} has no refs/remotes/origin/${base}.`);
  }

  const rootCanonical = await canonicalWritePath(options.workTreeRoot ?? defaultRoot);
  await refuseWorkTreeRootInGitWorkTree(rootCanonical, { gitRun });
  await assertWritableDirectory(rootCanonical, noun, { rootError });

  return { base, revision, workTreeRoot: rootCanonical, repoKey: repoKey(repo) };
}

/**
 * Resolves the repository, base branch, and work-tree root of a batch, refusing before any state
 * write or child process exists. `id` names the default work-tree root.
 * @param {object} options parsed options
 * @param {{ gitRun?: (args: string[], cwd: string) => Promise<string> }} [deps]
 */
export async function prepareBatch(options, { gitRun = gitOrThrow } = {}) {
  const repo = await canonicalPath(options.repo);
  const entries = await workTreeEntries(repo);
  const prepared = await prepareRepository({
    options,
    repo,
    entries,
    readText: gitRun,
    gitRun,
    noun: "batch",
    rootError: "throw",
    defaultRoot: join(dirname(repo), `${basename(repo)}-batch-${options.id ?? "preview"}`),
  });
  return {
    ...options,
    repo,
    base: prepared.base,
    workTreeRoot: prepared.workTreeRoot,
    repoKey: prepared.repoKey,
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
