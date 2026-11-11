// Argument parsing and preparation for `batch audit start`.
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { supportedAgents } from "../agents/index.mjs";
import { DEFAULT_TIMEOUT, openCodeOptionsError, STOP_FLAG_WALK, walkFlags } from "../lib/args.mjs";
import { normalizeAgent } from "../lib/agent-kinds.mjs";
import { canonicalPath } from "../lib/canonical-path.mjs";
import { parseWorkTreeList } from "../lib/git-read.mjs";
import { logRoleOptionWarnings, positiveInt, prepareRepository, usage } from "./args.mjs";
import { git } from "./git.mjs";

const MAX_REVIEWERS = 16;
const DEFAULT_SETUP_TIMEOUT = 600;

/**
 * Parses `agent-loop batch audit start` arguments. Throws an error with `usage: true` for a missing
 * or invalid value. An unknown model or effort logs one warning. Performs no filesystem read and
 * writes nothing.
 * @param {string[]} argv arguments after `batch audit start`
 */
export function parseAuditArgs(argv) {
  const options = {
    repo: null,
    reviewers: [],
    worker: null,
    workerModel: null,
    workerEffort: null,
    base: null,
    workTreeRoot: null,
    setupCmd: null,
    setupTimeout: DEFAULT_SETUP_TIMEOUT,
    timeout: DEFAULT_TIMEOUT,
    reviewerSandbox: null,
    focus: null,
    focusFile: null,
  };
  let current = null;
  let sandboxAlias = false;
  const repeated = new Map();
  const setScalar = (key, flag, value) => {
    if (repeated.has(key) && repeated.get(key) !== value) {
      throw usage(`${flag} conflicts with an earlier value.`);
    }
    repeated.set(key, value);
    return value;
  };

  let help = false;
  walkFlags(
    argv,
    0,
    (flag, read, inline) => {
      if (flag === "--help" || flag === "-h") {
        help = true;
        return STOP_FLAG_WALK;
      }
      switch (flag) {
        case "--repo":
          options.repo = resolve(read(flag));
          break;
        case "--reviewer":
          if (options.reviewers.length >= MAX_REVIEWERS) {
            throw usage(`--reviewer accepts at most ${MAX_REVIEWERS} entries.`);
          }
          current = { kind: read(flag), model: null, effort: null };
          options.reviewers.push(current);
          break;
        case "--reviewer-model":
          if (current === null) throw usage("--reviewer-model requires a preceding --reviewer.");
          current.model = read(flag);
          break;
        case "--reviewer-effort":
          if (current === null) throw usage("--reviewer-effort requires a preceding --reviewer.");
          current.effort = read(flag);
          break;
        case "--worker":
          options.worker = setScalar("worker", flag, read(flag));
          break;
        case "--worker-model":
          options.workerModel = setScalar("worker-model", flag, read(flag));
          break;
        case "--worker-effort":
          options.workerEffort = setScalar("worker-effort", flag, read(flag));
          break;
        case "--base":
          options.base = read(flag);
          break;
        case "--focus":
          options.focus = setScalar("focus", flag, read(flag));
          break;
        case "--focus-file":
          options.focusFile = setScalar("focus-file", flag, read(flag));
          break;
        case "--work-tree-root":
          options.workTreeRoot = resolve(read(flag));
          break;
        case "--setup-cmd":
          options.setupCmd = read(flag);
          break;
        case "--setup-timeout":
          options.setupTimeout = positiveInt(flag, read(flag));
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
          setSandbox(options, value, false, sandboxAlias);
          sandboxAlias = false;
          break;
        }
        case "--reviewer-workspace-write":
          if (inline !== null) throw usage("--reviewer-workspace-write does not take a value.");
          setSandbox(options, "workspace-write", true, sandboxAlias);
          sandboxAlias = true;
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
  if (options.focus !== null && options.focusFile !== null) {
    throw usage("--focus and --focus-file cannot be combined.");
  }
  if (options.focus !== null && options.focus.trim() === "") {
    throw usage("--focus must not be empty.");
  }
  if (options.reviewers.length < 2) throw usage("At least two --reviewer entries are required.");
  if (options.worker === null) throw usage("Missing required --worker.");
  const seen = new Set();
  for (const reviewer of options.reviewers) {
    const key = `${reviewer.kind}\0${reviewer.model}\0${reviewer.effort}`;
    if (seen.has(key)) throw usage(`Duplicate reviewer settings: ${reviewer.kind}.`);
    seen.add(key);
  }
  const logged = new Set();
  for (const reviewer of options.reviewers) {
    if (!supportedAgents.has(reviewer.kind)) {
      throw usage(`Unsupported reviewer: ${reviewer.kind}`);
    }
    const openCode = openCodeOptionsError(
      "reviewer",
      reviewer.kind,
      reviewer.model,
      reviewer.effort,
    );
    if (openCode) throw usage(openCode);
    logRoleOptionWarnings("reviewer", reviewer.kind, reviewer.model, reviewer.effort, logged);
  }
  if (!supportedAgents.has(options.worker)) {
    throw usage(`Unsupported worker: ${options.worker}`);
  }
  const workerOpenCode = openCodeOptionsError(
    "worker",
    options.worker,
    options.workerModel,
    options.workerEffort,
  );
  if (workerOpenCode) throw usage(workerOpenCode);
  logRoleOptionWarnings(
    "worker",
    options.worker,
    options.workerModel,
    options.workerEffort,
    logged,
  );
  if (
    options.reviewerSandbox !== null &&
    !options.reviewers.every((reviewer) => normalizeAgent(reviewer.kind) === "codex")
  ) {
    throw usage("--reviewer-sandbox requires every --reviewer to be codex.");
  }
  return options;
}

function setSandbox(options, value, viaAlias, aliasSeen) {
  const earlier = options.reviewerSandbox;
  if (earlier !== null && earlier !== value) {
    if (viaAlias || aliasSeen) {
      throw usage(`--reviewer-workspace-write conflicts with --reviewer-sandbox ${earlier}.`);
    }
    throw usage(`--reviewer-sandbox ${value} conflicts with --reviewer-sandbox ${earlier}.`);
  }
  options.reviewerSandbox = value;
}

/**
 * Resolves the reviewer focus from `--focus` or `--focus-file`. Returns null when none is supplied.
 * Throws a usage error for a read failure or a blank focus, before any state write.
 * @param {{ focus?: string|null, focusFile?: string|null }} options parsed options
 */
async function resolveFocus(options) {
  if ((options.focus ?? null) !== null && (options.focusFile ?? null) !== null) {
    throw usage("--focus and --focus-file cannot be combined.");
  }
  const fromFile = (options.focusFile ?? null) !== null;
  let focus = options.focus ?? null;
  if (fromFile) {
    try {
      focus = await readFile(resolve(options.focusFile), "utf8");
    } catch (err) {
      throw usage(
        `Cannot read --focus-file ${options.focusFile}: ${err?.code ?? err?.message ?? "unknown error"}`,
      );
    }
  }
  if (focus === null) return null;
  const text = focus.trim();
  if (text === "") throw usage(`${fromFile ? "--focus-file" : "--focus"} must not be empty.`);
  return text;
}

/**
 * Resolves the repository, base branch, revision, work-tree root, and focus of an audit, refusing
 * before any state write or child process exists.
 * @param {object} options parsed options
 * @param {{ gitRun?: (args: string[], cwd: string) => Promise<object> }} [deps]
 */
export async function prepareAudit(options, { gitRun = git } = {}) {
  const focus = await resolveFocus(options);
  const repo = await canonicalPath(options.repo);
  const listed = await gitRun(["worktree", "list", "--porcelain", "-z"], repo);
  if (listed.exitCode !== 0) throw usage(`--repo is not a Git work tree: ${listed.stderr}`);
  const entries = parseWorkTreeList(listed.stdout);
  // The audit runner returns an object. The shared reader reads a string and throws on failure.
  const readText = async (args, cwd) => {
    const result = await gitRun(args, cwd);
    if (result.exitCode !== 0 || result.stdout === "") {
      throw new Error(result.stderr || `exit ${result.exitCode}`);
    }
    return String(result.stdout).trim();
  };
  const rootRunner = async (args, cwd) => {
    const result = await gitRun(args, cwd);
    return result.exitCode === 0 && !result.timedOut ? result.stdout : "";
  };
  const prepared = await prepareRepository({
    options,
    repo,
    entries,
    readText,
    gitRun: rootRunner,
    noun: "audit",
    defaultRoot: join(dirname(repo), `${basename(repo)}-audit-${options.id ?? "preview"}`),
  });
  return {
    ...options,
    repo,
    base: prepared.base,
    revision: prepared.revision,
    workTreeRoot: prepared.workTreeRoot,
    repoKey: prepared.repoKey,
    focus,
    reviewers: options.reviewers.map((reviewer) => ({
      kind: normalizeAgent(reviewer.kind) ?? reviewer.kind,
      model: reviewer.model,
      effort: reviewer.effort,
    })),
    worker: {
      kind: normalizeAgent(options.worker) ?? options.worker,
      model: options.workerModel,
      effort: options.workerEffort,
    },
  };
}
