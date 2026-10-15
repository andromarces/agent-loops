// Machine-wide test slot (#847, ADR 0039). `agent-loop test-slot` runs one command only while
// it holds one of N lock files that every work tree and project of the OS user on the host
// shares, so parallel full-suite runs do not oversubscribe the host.
import { execa } from "execa";
import { availableParallelism, constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { killLiveTrees, killTreeOnExit } from "./exec-tree.mjs";
import { logDebug, logError, logInfo, setLogsToStderr } from "./log.mjs";
import { tryStateLock } from "./state-lock.mjs";

export const TEST_SLOT_USAGE_EXIT = 64;
export const TEST_SLOT_TIMEOUT_EXIT = 75;
const DEFAULT_WAIT_SECONDS = 1800;
// A wrapper that starts with this variable set runs inside a wrapped command, so it runs
// its command directly instead of waiting on the slot that its parent holds.
const HELD_ENV = "AGENT_LOOP_TEST_SLOT_HELD";
// Each wait between passes over the slots is this long plus a random part of the same size,
// so waiting wrappers do not poll in step.
const POLL_MS = 500;

export const TEST_SLOT_HELP = `
Usage:

  agent-loop test-slot [--slots <n>] [--wait <seconds>] [--] "<command>"

Runs <command> only while this process holds one of <n> machine-wide test slots.
The command is one argument, run through the platform shell (/bin/sh -c, or
cmd.exe on Windows) in the current directory, as --test-cmd runs its command.
Quote it as one argument for the calling shell. stdout and stderr pass through,
and stdin is closed.

Options:

  --slots <n>          Slot count. Defaults to max(1, floor(available CPUs / 8)).
                       Env: AGENT_LOOP_TEST_SLOTS. The flag wins over the env.
  --wait <seconds>     Longest wait for a free slot. Defaults to 1800 (30 minutes).
                       0 tries once. Env: AGENT_LOOP_TEST_SLOT_WAIT.
  -h, --help           Print this help.

Slots are lock files under <os tmpdir>/agent-loops/test-slots
(env AGENT_LOOP_TEST_SLOTS_ROOT overrides the directory). A slot whose owner
process is gone is reclaimed. The command runs with AGENT_LOOP_TEST_SLOT_HELD=1,
and a wrapper that starts with it set runs its command at once, so a nested call
cannot deadlock. SIGINT or SIGTERM ends the command's process tree, then frees
the slot.

Exit codes:

  <command's code>     The command ran. A command ended by a signal gives 128 + the signal number.
  64                   Usage error. The command did not run.
  75                   No slot was free within the wait bound. The command did not run.
  130, 143             SIGINT or SIGTERM reached the wrapper.
  1                    Any other wrapper failure, such as a slot directory that cannot be written.
`.trim();

const usageError = (message) => Object.assign(new Error(message), { usage: true });

function slotCount(value, name) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw usageError(`${name} must be a positive integer, got "${value}".`);
  }
  return Number(value);
}

function waitSeconds(value, name) {
  const seconds = Number(value);
  if (value.trim() === "" || !Number.isFinite(seconds) || seconds < 0) {
    throw usageError(`${name} must be a number of seconds of 0 or more, got "${value}".`);
  }
  return seconds;
}

/**
 * Parses the `test-slot` argv. An empty environment value counts as unset; a flag wins over
 * its environment value. Throws an error with `usage: true` on an invalid value.
 * @returns {{ help: true } | { slots: number, waitSeconds: number, command: string }}
 */
export function parseTestSlotArgs(argv, env = process.env) {
  let slots = env.AGENT_LOOP_TEST_SLOTS
    ? slotCount(env.AGENT_LOOP_TEST_SLOTS, "AGENT_LOOP_TEST_SLOTS")
    : Math.max(1, Math.floor(availableParallelism() / 8));
  let wait = env.AGENT_LOOP_TEST_SLOT_WAIT
    ? waitSeconds(env.AGENT_LOOP_TEST_SLOT_WAIT, "AGENT_LOOP_TEST_SLOT_WAIT")
    : DEFAULT_WAIT_SECONDS;
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--slots" || arg === "--wait") {
      const value = argv[++i];
      if (value === undefined) {
        throw usageError(`${arg} needs a value.`);
      }
      if (arg === "--slots") {
        slots = slotCount(value, arg);
      } else {
        wait = waitSeconds(value, arg);
      }
      continue;
    }
    if (arg !== "--" && arg.startsWith("-")) {
      throw usageError(`Unknown option ${arg}.`);
    }
    rest = argv.slice(arg === "--" ? i + 1 : i);
    break;
  }
  if (rest.length !== 1 || rest[0].trim() === "") {
    throw usageError("Pass the command as exactly one argument, quoted for the calling shell.");
  }
  return { slots, waitSeconds: wait, command: rest[0] };
}

function slotsRoot() {
  const override = process.env.AGENT_LOOP_TEST_SLOTS_ROOT;
  return override ? resolve(override) : join(tmpdir(), "agent-loops", "test-slots");
}

// Takes the first free slot of `slot-0` .. `slot-<slots - 1>`, polling until `waitMs` ends.
// Returns `{ index, release }`, or null at the bound or on an abort.
async function acquireSlot({ root, slots, waitMs, signal }) {
  const deadline = Date.now() + waitMs;
  let waiting = false;
  for (;;) {
    for (let index = 0; index < slots; index++) {
      const release = await tryStateLock(join(root, `slot-${index}.lock`), {
        label: `Test slot ${index}`,
        noun: "test slot",
      });
      if (release) {
        return { index, release };
      }
    }
    const left = deadline - Date.now();
    if (left <= 0 || signal.aborted) {
      return null;
    }
    if (!waiting) {
      waiting = true;
      logInfo(`waiting for a free test slot (${slots} in ${root}, bound ${waitMs / 1000}s)`);
    }
    try {
      await delay(Math.min(left, POLL_MS + Math.random() * POLL_MS), undefined, { signal });
    } catch {
      return null;
    }
  }
}

const signalExit = (name) => 128 + (constants.signals[name] ?? 0);

// Runs the command with the `--test-cmd` runner semantics: the platform shell, and a process
// group (POSIX) or tree (Windows) that `killLiveTrees` ends. The command text is never logged.
async function runCommand(command, env) {
  logInfo("test slot command started");
  const result = await killTreeOnExit(
    execa(command, {
      shell: true,
      reject: false,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env,
      cleanup: true,
      killDescendants: true,
    }),
  );
  if (typeof result.exitCode === "number") {
    logInfo(`test slot command finished: exit ${result.exitCode}`);
    return result.exitCode;
  }
  if (result.signal) {
    logInfo(`test slot command finished: signal ${result.signal}`);
    return signalExit(result.signal);
  }
  logError(`test slot command did not start: ${result.code ?? "unknown error"}`);
  return 1;
}

/**
 * Runs `agent-loop test-slot` and returns its exit code (see `TEST_SLOT_HELP`). Side effects:
 * creates and removes a slot lock file, routes every log line to stderr, and listens for SIGINT
 * and SIGTERM until it returns. A signal ends the command's process tree before the slot is freed.
 */
export async function runTestSlot(argv) {
  setLogsToStderr(true);
  let options;
  try {
    options = parseTestSlotArgs(argv);
  } catch (err) {
    if (!err.usage) {
      throw err;
    }
    logError(err.message);
    return TEST_SLOT_USAGE_EXIT;
  }
  if (options.help) {
    console.log(TEST_SLOT_HELP);
    return 0;
  }

  const controller = new AbortController();
  let received = null;
  const onSignal = (name) => {
    received ??= name;
    controller.abort();
    killLiveTrees();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    if (process.env[HELD_ENV]) {
      logDebug("a parent wrapper holds a test slot; running the command directly");
      return await runCommand(options.command);
    }
    const root = slotsRoot();
    const slot = await acquireSlot({
      root,
      slots: options.slots,
      waitMs: options.waitSeconds * 1000,
      signal: controller.signal,
    });
    if (slot === null) {
      if (received) {
        return signalExit(received);
      }
      logError(`no test slot free after ${options.waitSeconds}s; the command did not run`);
      return TEST_SLOT_TIMEOUT_EXIT;
    }
    logInfo(`test slot ${slot.index} acquired`);
    try {
      const code = received ? null : await runCommand(options.command, { [HELD_ENV]: "1" });
      return received ? signalExit(received) : code;
    } finally {
      await slot.release();
      logInfo(`test slot ${slot.index} released`);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
