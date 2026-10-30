import { execa } from "execa";
import { killTreeOnExit } from "./exec-tree.mjs";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logDebug, logInfo, logWarn } from "./log.mjs";
import { rootPins } from "./root-pins.mjs";
import { cwdHash } from "./runstate.mjs";

/**
 * Environment variable that marks a process spawned for a worker or reviewer turn. Its value is
 * a comma-separated list of run keys, the names of state directories: the keys of every enclosing
 * run, outermost first, then the key of the run that dispatched the turn. `role extend`, `set-model`, `finish`,
 * and `abort` refuse a caller whose list holds the key they use to find the run state, so a
 * descendant of a run never ends or extends it, while a parent that inherited the marker of
 * another run is not refused. Every descendant of the spawned process inherits it (issues #392,
 * #548). An empty value counts as unset.
 */
export const SPAWNED_RUN_ENV = "AGENT_LOOP_SPAWNED_RUN";

/** Appends `key` to the marker list that this process inherited, once. */
function markerFor(key) {
  const keys = (process.env[SPAWNED_RUN_ENV] ?? "").split(",").filter(Boolean);
  return (keys.includes(key) ? keys : [...keys, key]).join(",");
}

/** True when the inherited marker list holds `key`. */
export function isSpawnedByRun(key) {
  return (process.env[SPAWNED_RUN_ENV] ?? "").split(",").includes(key);
}

// `exec` adds no marker for the orchestrator or any other spawn. A process keeps a marker it
// inherited.
const MARKED_ROLES = new Set(["worker", "reviewer"]);

// npm reads these settings from an environment name of any case, with `_` or `-` before the key.
const NPM_LOG_NAME = /^npm_config_logs[_-](dir|max)$/i;
const settingOf = (name) => NPM_LOG_NAME.exec(name)?.[1].toLowerCase();

/**
 * Returns `env`, the complete child environment, with the npm log settings resolved to one spelling
 * each, so npm writes no debug log in a child turn that the cleanup rule cannot clear (issue #995).
 * npm writes them to its cache, outside the work tree and the turn temporary directory.
 * `callerEnv` is the `env` option of the spawn. For each of `logs_dir` and `logs_max`, the value
 * is the last non-empty one in the process environment and then in `callerEnv`, in any spelling,
 * so a caller wins. Every spelling is removed and the value is set once, as `npm_config_<key>`. An
 * empty value counts as unset, as for the roots, and no empty alias is left to mask a user value
 * (names that differ in case are one name on Windows). With neither setting held, `logs_max` is
 * `0`, which writes no log for the run. A held `logs_dir` keeps the default out, so the chosen
 * directory still receives its logs. The caller must spawn without `extendEnv`, because a name
 * that is missing from `env` would return from the process environment.
 */
function withNpmLogSettings(env, callerEnv = {}) {
  const held = {};
  for (const source of [process.env, callerEnv]) {
    for (const [name, value] of Object.entries(source)) {
      const key = settingOf(name);
      if (key && value) held[key] = value;
    }
  }
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !settingOf(name)));
  if (!held.dir && !held.max) held.max = "0";
  for (const [key, value] of Object.entries(held)) out[`npm_config_logs_${key}`] = value;
  return out;
}

// pnpm reads this setting from an environment name of any case.
const PNPM_DEPS_CHECK_NAME = /^pnpm_config_verify_deps_before_run$/i;

/**
 * Returns `env`, the complete child environment, with `pnpm_config_verify_deps_before_run` set to
 * `warn` in one spelling, so pnpm never installs from its dependency check before `pnpm run` or
 * `pnpm exec` (issue #1145). The default `install` can write to the `node_modules` of the work tree
 * and to the shared pnpm store, outside the reach of the mutation check. The environment overrides
 * a `verifyDepsBeforeRun` workspace setting. An inherited value of any case is dropped, and `warn`
 * wins over a user value.
 */
export function withPnpmDepsCheckWarn(env) {
  const out = Object.fromEntries(
    Object.entries(env).filter(([name]) => !PNPM_DEPS_CHECK_NAME.test(name)),
  );
  out.pnpm_config_verify_deps_before_run = "warn";
  return out;
}

export class ExecError extends Error {
  constructor(
    message,
    {
      command,
      exitCode,
      stdout,
      stderr,
      timedOut,
      isCanceled,
      isTerminated,
      isMaxBuffer,
      signal,
    } = {},
  ) {
    super(message);
    this.name = "ExecError";
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout ?? "";
    this.stderr = stderr ?? "";
    this.timedOut = Boolean(timedOut);
    this.isCanceled = Boolean(isCanceled);
    this.isTerminated = Boolean(isTerminated);
    this.isMaxBuffer = Boolean(isMaxBuffer);
    // The signal name or description, for a caller that reports the termination cause. It travels as
    // a field, not in the message, so every adapter keeps the message `exec` has always built.
    this.signal = signal ?? null;
  }
}

/**
 * `options.onSpawn(pid)` is called once, right after the child starts and only when it has a pid.
 * It runs beside the child and is awaited before `exec` returns or throws. A rejection warns and
 * never changes the outcome of the child.
 */
export async function exec(command, args = [], options = {}) {
  const { cwd, input, timeout, signal, role, env, maxBuffer, onSpawn } = options;

  const label = role ? `${role}: ${command}` : command;
  const startedAt = Date.now();
  logInfo(`${label} started`);

  const execaOptions = {
    cwd,
    reject: false,
    input,
    stdin: input === undefined ? "ignore" : undefined,
    killDescendants: true,
  };

  // Characters of decoded text per output stream. Unset keeps the execa default.
  if (maxBuffer !== undefined) {
    execaOptions.maxBuffer = maxBuffer;
  }

  // execa merges env with process.env; the child still inherits the launcher environment. A marked
  // role passes the whole environment, because `withNpmLogSettings` must drop inherited spellings.
  const marked = MARKED_ROLES.has(role);
  if (env || marked) {
    const childEnv = {
      ...(marked && rootPins()),
      ...env,
      ...(marked && { [SPAWNED_RUN_ENV]: markerFor(cwdHash(cwd ?? process.cwd())) }),
    };
    if (marked) {
      const markedEnv = withNpmLogSettings({ ...process.env, ...childEnv }, env);
      execaOptions.env = role === "reviewer" ? withPnpmDepsCheckWarn(markedEnv) : markedEnv;
      execaOptions.extendEnv = false;
    } else {
      execaOptions.env = childEnv;
    }
  }

  if (typeof timeout === "number" && timeout > 0) {
    execaOptions.timeout = timeout * 1000;
  }

  if (signal) {
    execaOptions.cancelSignal = signal;
  }

  const subprocess = killTreeOnExit(execa(command, args, execaOptions));
  const { pid } = subprocess;
  // Settled at once, so a rejection before the child ends is never unhandled.
  const hook =
    Number.isInteger(pid) && onSpawn
      ? Promise.resolve()
          .then(() => onSpawn(pid))
          .catch((err) =>
            logWarn(`${label}: the spawn hook failed: ${firstErrorLine(readableErrorText(err))}`),
          )
      : undefined;
  const result = await subprocess;
  await hook;

  const timedOut = Boolean(result.timedOut);
  const isCanceled = Boolean(result.isCanceled);
  const isTerminated = Boolean(result.isTerminated);
  // execa can report an overflow with exit code 0 and a cut stream.
  const isMaxBuffer = Boolean(result.isMaxBuffer);

  if (result.exitCode !== 0 || timedOut || isCanceled || isTerminated || isMaxBuffer) {
    const signal = result.signalDescription ?? result.signal;
    let cause;
    if (timedOut) {
      cause = `${command} timed out after ${timeout} seconds.`;
    } else if (isCanceled) {
      cause = `${command} was canceled.`;
    } else if (isMaxBuffer) {
      cause = `${command} output exceeded the buffer limit and was cut.`;
    } else if (isTerminated) {
      // POSIX-only: execa cannot detect signal termination on Windows.
      cause = `${command} was killed by ${signal ?? "a signal"}.`;
    } else if (result.exitCode === undefined) {
      // POSIX-only: execa leaves exitCode undefined when the subprocess
      // could not be spawned (Windows reports exit code 1 instead).
      cause = `${command} failed to start.`;
    } else {
      cause = `${command} exited with code ${result.exitCode}.`;
    }

    // An overflow cuts a stream at an arbitrary character, so it can end inside a secret value
    // that exact-value redaction no longer matches. The error therefore keeps none of the output.
    const output = isMaxBuffer ? [] : [result.stderr?.trim(), result.stdout?.trim()];
    const message = [cause, ...output].filter(Boolean).join("\n\n");

    // The caller owns the failure level (it knows whether the runtime recovers); this
    // debug line terminates the invocation trace when the caller does not log one.
    logDebug(`${label} failed in ${Date.now() - startedAt}ms: ${cause}`);

    throw new ExecError(message, {
      command,
      exitCode: result.exitCode,
      stdout: isMaxBuffer ? "" : result.stdout,
      stderr: isMaxBuffer ? "" : result.stderr,
      timedOut,
      isCanceled,
      isTerminated,
      isMaxBuffer,
      signal,
    });
  }

  const durationMs = Date.now() - startedAt;
  logInfo(`${label} finished in ${durationMs}ms (exit 0)`);

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs,
  };
}

/**
 * Runs `command` and returns the raw execa result, never throwing for a nonzero exit, a timeout, or
 * a cancel: the caller reads `exitCode`, `timedOut`, `isCanceled`, and the output. `timeoutMs`
 * bounds the call and `signal` cancels it. Either one kills the child, with SIGTERM then SIGKILL
 * after 1 s on POSIX and `taskkill /T /F` over the process tree on Windows, so no platform keeps a
 * child the bound gave up on (#329). `execaOptions` pass through, for example `stripFinalNewline`.
 * The run logs nothing, so a caller that reads sensitive output controls what is logged.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal | null } & import("execa").Options} [options]
 */
export function execBounded(
  command,
  args,
  { cwd, timeoutMs = 0, signal = null, ...execaOptions } = {},
) {
  const options = { cwd, reject: false, cleanup: true, killDescendants: true, ...execaOptions };
  if (timeoutMs > 0) {
    options.timeout = timeoutMs;
    options.forceKillAfterDelay = 1000;
  }
  if (signal) {
    options.cancelSignal = signal;
  }
  return killTreeOnExit(execa(command, args, options));
}
