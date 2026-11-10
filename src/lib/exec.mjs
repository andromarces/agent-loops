import { Socket } from "node:net";
import { execa } from "execa";
import { killTreeOnExit } from "./exec-tree.mjs";
import { errorLine, readProp } from "./error-message.mjs";
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

/** The `SPAWNED_RUN_ENV` value that a child spawned in `cwd` receives. */
export function spawnedRunMarker(cwd = process.cwd()) {
  return markerFor(cwdHash(cwd));
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
 * `warn` in one spelling. That stops pnpm from installing from its dependency check before
 * `pnpm run` or `pnpm exec` (issues #1145, #1385). The default `install` can write to the
 * `node_modules` of the work tree and to the shared pnpm store, outside the reach of the mutation
 * check. The environment overrides a `verifyDepsBeforeRun` workspace setting. An inherited value
 * of any case is dropped, and `warn` wins over a user value.
 */
function withPnpmDepsCheckWarn(env) {
  const out = Object.fromEntries(
    Object.entries(env).filter(([name]) => !PNPM_DEPS_CHECK_NAME.test(name)),
  );
  out.pnpm_config_verify_deps_before_run = "warn";
  return out;
}

// Idle bound on the pipes of an exited child: no byte read for this long, and no read held back by
// a slow consumer. A descendant that inherited a pipe and outlived the child keeps the pipe open.
// The exit event of the child is then the last event that execa sees (issue #1302).
const STDIO_DRAIN_GRACE_MS = 3000;
// Bound on the wait for a child to exit after the timeout or the cancel killed it. It exceeds the
// force-kill delays of `exec` (5 s) and `execBounded` (1 s). A child that no kill ends, for example
// one stuck in a kernel I/O request, never emits `exit` (issue #1302).
export const KILL_GRACE_MS = 10_000;

// The idle pipe bound. Absent keeps the default. Any other value must be a finite number of 0 or more.
function drainGraceOf(value) {
  if (value === undefined) return STDIO_DRAIN_GRACE_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`drainGraceMs must be a finite number of 0 or more, got ${String(value)}.`);
  }
  return value;
}

/**
 * Waits for `subprocess` like `await subprocess`, with two bounds that never change a run that ends
 * on its own.
 * - `drainGraceMs` bounds an idle pipe that another process holds open after the child exits.
 *   The call then signals the process group it owns (POSIX) and ends that pipe.
 * - `KILL_GRACE_MS` bounds a child that no exit follows after `timeoutMs` or `signal`. The call
 *   settles as timed out or canceled with empty output, and the parent ends its pipe ends.
 * A descendant that left the process group survives both bounds, and so does a Windows descendant
 * of an exited child (ADR 0017).
 */
function settleWithin(
  subprocess,
  {
    timeoutMs = 0,
    signal = null,
    label,
    killGraceMs = KILL_GRACE_MS,
    drainGraceMs = STDIO_DRAIN_GRACE_MS,
  },
) {
  const child = subprocess.nodeChildProcess ?? subprocess;
  const timers = new Set();
  let stopWaiting;
  const gaveUp = new Promise((resolve) => {
    stopWaiting = resolve;
  });
  const after = (ms, action) => timers.add(setTimeout(action, ms));
  // The OS pipes of the child. With a transform, the stream is the output of the transform. Execa
  // ends that stream with its input, so the bound leaves it alone.
  const pipes = [child.stdout, child.stderr].filter((stream) => stream instanceof Socket);
  let exited = false;
  let drainTimer;
  const armDrain = () => {
    clearTimeout(drainTimer);
    drainTimer = setTimeout(onDrainIdle, drainGraceMs);
  };
  // Each later read restarts the idle bound, as the child exit does.
  const onRead = () => exited && armDrain();
  // Output already read stays in the result, and a downstream transform or reader still gets every byte.
  const endPipes = () => {
    for (const stream of pipes) stream.push(null);
  };
  const giveUp = (reason) => {
    logWarn(`${label}: the child did not exit ${killGraceMs}ms after ${reason}; not waiting`);
    endPipes();
    for (const stream of pipes) stream.destroy();
    child.unref?.();
    stopWaiting({
      exitCode: undefined,
      timedOut: reason === "the timeout",
      isCanceled: reason === "the cancel",
      isTerminated: false,
      isMaxBuffer: false,
      stdout: "",
      stderr: "",
    });
  };
  // A pipe that ended is not held. One that is paused or holds unread bytes waits for the consumer
  // of this process, which ends on its own. Any other idle pipe is held by another process.
  function onDrainIdle() {
    const held = pipes.filter((stream) => !stream.readableEnded && !stream.destroyed);
    if (held.length === 0) return;
    if (held.some((stream) => stream.isPaused() || stream.readableLength > 0)) return armDrain();
    logWarn(
      `${label}: a process holds the output open ${drainGraceMs}ms after the child exit; ending the process group and the read`,
    );
    // Reaches the process group on POSIX. Nothing reaches a descendant of an exited child on Windows.
    subprocess.kill?.("SIGKILL");
    // The descendant no longer holds the call.
    endPipes();
  }
  const onExit = () => {
    exited = true;
    armDrain();
  };
  const onAbort = () => after(killGraceMs, () => giveUp("the cancel"));

  for (const stream of pipes) stream.on("data", onRead);
  if (child.exitCode != null || child.signalCode != null) onExit();
  else child.once?.("exit", onExit);
  if (timeoutMs > 0) after(timeoutMs + killGraceMs, () => giveUp("the timeout"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  // Read now: `execBounded` replaces `then` on the subprocess with this result.
  // A spawn double in a test can return a plain result, which `await` passes through.
  const finished =
    typeof subprocess.then === "function"
      ? new Promise((resolve, reject) => subprocess.then(resolve, reject))
      : Promise.resolve(subprocess);
  // Neither Node nor execa can reach a descendant that survives both bounds (ADR 0017).
  return Promise.race([finished, gaveUp]).finally(() => {
    timers.forEach(clearTimeout);
    clearTimeout(drainTimer);
    for (const stream of pipes) stream.off("data", onRead);
    child.off?.("exit", onExit);
    signal?.removeEventListener("abort", onAbort);
  });
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
 * Names why a child ended abnormally, in the wording of the `exec` error message: a timeout, a
 * cancel, a buffer overflow, a signal, or a spawn failure. Returns an empty string for an ordinary
 * non-zero exit, which `exec` words with the exit code. `failure` takes the `ExecError` fields
 * `timedOut`, `isCanceled`, `isMaxBuffer`, `isTerminated`, `exitCode`, and `signal`, and may be any
 * value. `timeout` is the bound in seconds; a non-number gives the wording without it.
 */
export function execFailureCause(command, failure, timeout) {
  // Each read is guarded, so a hostile getter on an error never replaces the original failure.
  const read = (key) => readProp(failure, key);
  if (read("timedOut")) {
    return typeof timeout === "number"
      ? `${command} timed out after ${timeout} seconds.`
      : `${command} timed out.`;
  }
  if (read("isCanceled")) return `${command} was canceled.`;
  if (read("isMaxBuffer")) return `${command} output exceeded the buffer limit and was cut.`;
  if (read("isTerminated")) {
    // POSIX-only: execa cannot detect signal termination on Windows.
    return `${command} was killed by ${read("signal") ?? "a signal"}.`;
  }
  // POSIX-only: execa leaves exitCode undefined when the subprocess
  // could not be spawned (Windows reports exit code 1 instead).
  if (read("exitCode") == null) return `${command} failed to start.`;
  return "";
}

/**
 * Runs `command` and returns `{ stdout, stderr, durationMs }` after an exit with code 0.
 * Throws `ExecError` for a non-zero exit, a timeout, a cancel, a signal kill, a spawn failure, or
 * output past `maxBuffer`.
 * `options.role` labels the log lines, and the roles `worker` and `reviewer` rebuild the child
 * environment with `extendEnv: false`.
 * `options.onSpawn(pid)` runs once after the child starts and is awaited before `exec` returns or
 * throws.
 * `options.treeEnd` ends the child and its descendants at a parent SIGTERM or SIGINT (POSIX only,
 * ADR 0071).
 * `options.drainGraceMs` overrides the idle pipe bound, while production keeps the 3000 ms default.
 */
export async function exec(command, args = [], options = {}) {
  const {
    cwd,
    input,
    timeout,
    signal,
    role,
    env,
    maxBuffer,
    onSpawn,
    treeEnd,
    forceKillAfterDelay,
    drainGraceMs,
  } = options;
  const drainGrace = drainGraceOf(drainGraceMs);

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
  // The child environment holds `env` over the process environment, the run marker
  // `SPAWNED_RUN_ENV`, the root pins from `rootPins`, and the npm log settings from
  // `withNpmLogSettings`.
  const marked = MARKED_ROLES.has(role);
  if (env || marked) {
    const childEnv = {
      ...(marked && rootPins()),
      ...env,
      ...(marked && { [SPAWNED_RUN_ENV]: spawnedRunMarker(cwd) }),
    };
    if (marked) {
      const markedEnv = withNpmLogSettings({ ...process.env, ...childEnv }, env);
      // A worker and a reviewer also get the pnpm deps check set to `warn`.
      execaOptions.env = withPnpmDepsCheckWarn(markedEnv);
      execaOptions.extendEnv = false;
    } else {
      // Any other role keeps the inherited environment, with `env` over it.
      execaOptions.env = childEnv;
    }
  }

  if (typeof timeout === "number" && timeout > 0) {
    execaOptions.timeout = timeout * 1000;
  }

  // Injectable so a test can shorten the delay; production keeps execa's 5000 ms default (issue #1465).
  if (forceKillAfterDelay !== undefined) {
    execaOptions.forceKillAfterDelay = forceKillAfterDelay;
  }

  if (signal) {
    execaOptions.cancelSignal = signal;
  }

  // `treeEnd` reaches a descendant that left the child's process group.
  const subprocess = killTreeOnExit(execa(command, args, execaOptions), { treeEnd });
  const { pid } = subprocess;
  // Settled at once, so a rejection before the child ends is never unhandled. Called once beside
  // the child, only when it has a pid, and awaited before `exec` returns or throws. A rejection
  // warns and never changes the outcome.
  const hook =
    Number.isInteger(pid) && onSpawn
      ? Promise.resolve()
          .then(() => onSpawn(pid))
          .catch((err) => logWarn(`${label}: the spawn hook failed: ${errorLine(err)}`))
      : undefined;
  const result = await settleWithin(subprocess, {
    timeoutMs: execaOptions.timeout,
    signal,
    label,
    drainGraceMs: drainGrace,
  });
  await hook;

  const timedOut = Boolean(result.timedOut);
  const isCanceled = Boolean(result.isCanceled);
  const isTerminated = Boolean(result.isTerminated);
  // execa can report an overflow with exit code 0 and a cut stream.
  const isMaxBuffer = Boolean(result.isMaxBuffer);

  if (result.exitCode !== 0 || timedOut || isCanceled || isTerminated || isMaxBuffer) {
    const signal = result.signalDescription ?? result.signal;
    const cause =
      execFailureCause(
        command,
        { timedOut, isCanceled, isMaxBuffer, isTerminated, exitCode: result.exitCode, signal },
        timeout,
      ) || `${command} exited with code ${result.exitCode}.`;

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
 * `killBound` arms the same give-up bound for a caller that sends its own kill. Its `{ timeoutMs,
 * signal }` reaches `settleWithin` and never reaches execa. The caller's immediate SIGKILL is then
 * the only kill (#1307). The run logs nothing, so a caller that reads sensitive output controls
 * what is logged.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal | null,
 *   killBound?: { timeoutMs?: number, signal?: AbortSignal | null } | null } &
 *   import("execa").Options} [options]
 */
export function execBounded(
  command,
  args,
  {
    cwd,
    timeoutMs = 0,
    signal = null,
    killBound = null,
    killGraceMs = KILL_GRACE_MS,
    drainGraceMs,
    ...execaOptions
  } = {},
) {
  const drainGrace = drainGraceOf(drainGraceMs);
  const options = { cwd, reject: false, cleanup: true, killDescendants: true, ...execaOptions };
  if (timeoutMs > 0) {
    options.timeout = timeoutMs;
    options.forceKillAfterDelay = 1000;
  }
  if (signal) {
    options.cancelSignal = signal;
  }
  const subprocess = killTreeOnExit(execa(command, args, options));
  if (typeof subprocess?.then !== "function") return subprocess;
  // The bounds apply to `await` and to `.then`, while `kill`, `pid`, and the streams stay execa's.
  const settled = settleWithin(subprocess, {
    timeoutMs: killBound?.timeoutMs ?? timeoutMs,
    signal: killBound?.signal ?? signal,
    label: `${command} (bounded)`,
    killGraceMs,
    drainGraceMs: drainGrace,
  });
  for (const method of ["then", "catch", "finally"]) {
    subprocess[method] = (...callbacks) => settled[method](...callbacks);
  }
  return subprocess;
}
