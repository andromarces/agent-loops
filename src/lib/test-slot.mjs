// Machine-wide test slot (#847, ADR 0039). `agent-loop test-slot` runs one command only while
// it holds one of the slot lock files that every work tree and project of the OS user on the
// host shares, so parallel full-suite runs do not oversubscribe the host.
import { execa } from "execa";
import { readdir } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { killLiveTrees, killTreeOnExit } from "./exec-tree.mjs";
import { logDebug, logError, logInfo, logWarn, setLogsToStderr } from "./log.mjs";
import { ownerAlive } from "./process-identity.mjs";
import { lockHeld, readLockOwner, tryStateLock } from "./state-lock.mjs";

export const TEST_SLOT_USAGE_EXIT = 64;
export const TEST_SLOT_TIMEOUT_EXIT = 75;
const DEFAULT_WAIT_SECONDS = 1800;
// One slot on every host: 2 slots on a 16-CPU host gave 15 s test timeouts (ADR 0046).
const DEFAULT_SLOTS = 1;
// The command runs with this variable set to `{"lock": <slot file>, "nonce": <owner nonce>}`.
// A wrapper that starts with it set runs its command directly only while that slot file
// still holds that nonce and a live owner, so a stale or hand-set marker is ignored.
const HELD_ENV = "AGENT_LOOP_TEST_SLOT_HELD";
// Each wait between passes is this long plus a random part of the same size, so waiting
// wrappers do not poll in step.
const POLL_MS = 500;
const SLOT_FILE = /^slot-(\d+)\.lock$/;

export const TEST_SLOT_HELP = `
Usage:

  agent-loop test-slot [--if-held] [--slots <n>] [--wait <seconds>] [--] "<command>"

Runs <command> only while this process holds one of the machine-wide test slots.
A wrapper starts only while fewer than its own <n> slots are held by live
owners, so wrappers that pass different <n> never run more than the largest
<n> among them. The command is one argument, run through the platform shell
(/bin/sh -c, or cmd.exe on Windows) in the current directory, as --test-cmd
runs its command. Quote it as one argument for the calling shell. stdout and
stderr pass through, and stdin is closed.

Options:

  --slots <n>          Slot count. Defaults to 1 (ADR 0046).
                       Env: AGENT_LOOP_TEST_SLOTS.
  --wait <seconds>     Longest wait for a slot. Defaults to 1800 (30 minutes).
                       0 is one attempt: run if a slot is free now, else exit 75
                       at once. Env: AGENT_LOOP_TEST_SLOT_WAIT.
  --if-held            Run <command> directly, holding no slot, while no slot is
                       held by a live owner. While any slot is held, wait for a
                       slot as without the flag. The check is one read with no
                       lock: a command that starts while all slots are free holds
                       no slot, so another wrapper can start beside it (ADR 0044).
  -h, --help           Print this help.

A flag wins over its env, and an env value is read only when its flag is absent.
An empty env value counts as unset, and an invalid one is a usage error.

Slots are lock files under <os tmpdir>/agent-loops/test-slots (env
AGENT_LOOP_TEST_SLOTS_ROOT overrides the directory). The directory is not per
user: where the OS temp directory is shared between users, as /tmp on Linux,
set AGENT_LOOP_TEST_SLOTS_ROOT to a directory per user. A slot whose owner
process is gone is reclaimed.

The command runs with AGENT_LOOP_TEST_SLOT_HELD set to its slot and owner. A
wrapper that starts with it set, while that slot is still held by that live
owner, runs its command at once in the same process group, so a nested call
cannot deadlock. Any other marker is ignored. SIGINT or SIGTERM ends the
command's process tree, then frees the slot.

Approved limits (ADR 0039, ADR 0044, docs/reference/usage.md#test-slot): a slot directory
shared between OS users, detached work that outlives the slot release, and on
POSIX a signal sent only to a nested wrapper, which can leave grandchildren.

Exit codes:

  <command's code>     The command ran. A command ended by a signal gives 128 + the signal number.
  64                   Usage error. The command did not run.
  75                   No slot was won within the wait bound. The command did not run.
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
 * Parses the `test-slot` argv. A flag wins over its environment value, which is read only when
 * the flag is absent; an empty environment value counts as unset. Throws an error with
 * `usage: true` on an invalid value that applies.
 * @returns {{ help: true } | { slots: number, waitSeconds: number, ifHeld: boolean, command: string }}
 */
export function parseTestSlotArgs(argv, env = process.env) {
  let slots = null;
  let wait = null;
  let ifHeld = false;
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--if-held") {
      ifHeld = true;
      continue;
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
  return { ...testSlotOptions(env, { slots, waitSeconds: wait }), ifHeld, command: rest[0] };
}

/**
 * The slot count and wait bound: each flag value that is not null, else its environment value,
 * else its default. Throws an error with `usage: true` on an invalid environment value that
 * applies.
 * @returns {{ slots: number, waitSeconds: number }}
 */
export function testSlotOptions(
  env = process.env,
  { slots = null, waitSeconds: wait = null } = {},
) {
  slots ??= env.AGENT_LOOP_TEST_SLOTS
    ? slotCount(env.AGENT_LOOP_TEST_SLOTS, "AGENT_LOOP_TEST_SLOTS")
    : DEFAULT_SLOTS;
  wait ??= env.AGENT_LOOP_TEST_SLOT_WAIT
    ? waitSeconds(env.AGENT_LOOP_TEST_SLOT_WAIT, "AGENT_LOOP_TEST_SLOT_WAIT")
    : DEFAULT_WAIT_SECONDS;
  return { slots, waitSeconds: wait };
}

function slotsRoot() {
  const override = process.env.AGENT_LOOP_TEST_SLOTS_ROOT;
  return override ? resolve(override) : join(tmpdir(), "agent-loops", "test-slots");
}

// One pass under the short `acquire.lock`: counts the slot files held by live owners and, while
// fewer than `slots` are held, takes the lowest free index (`tryStateLock` reclaims a dead
// owner's file). Returns `{ index, lockFile, release }`, or null when the pass wins no slot.
async function tryAcquireSlot(root, slots) {
  const releaseTable = await tryStateLock(join(root, "acquire.lock"), {
    label: "Test slot table",
    noun: "test slot table",
  });
  if (!releaseTable) {
    return null;
  }
  const errors = [];
  let slot = null;
  try {
    slot = await claimSlot(root, slots);
  } catch (err) {
    errors.push(err);
  }
  try {
    await releaseTable();
  } catch (err) {
    errors.push(err);
    // A slot taken under a table lock that fails to release is freed before the error
    // propagates, so the failure never leaks a held slot.
    try {
      await slot?.release();
    } catch (releaseErr) {
      errors.push(releaseErr);
    }
  }
  if (errors.length > 1) {
    // Every failure stays in the message, so a later one never hides the cause.
    throw new AggregateError(errors, errors.map((err) => err?.message ?? String(err)).join("; "));
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  return slot;
}

// Counts the held slot files (`lockHeld`: an unreadable file counts, a stale one does not) and,
// while fewer than `slots` are held, takes the lowest free index. Runs under the table lock.
async function claimSlot(root, slots) {
  const held = new Set();
  for (const entry of await readdir(root)) {
    const match = SLOT_FILE.exec(entry);
    if (match && (await lockHeld(join(root, entry)))) {
      held.add(Number(match[1]));
    }
  }
  for (let index = 0; held.size < slots; index++) {
    if (held.has(index)) {
      continue;
    }
    const lockFile = join(root, `slot-${index}.lock`);
    const release = await tryStateLock(lockFile, {
      label: `Test slot ${index}`,
      noun: "test slot",
    });
    if (release) {
      return { index, lockFile, release, nonce: (await readLockOwner(lockFile))?.nonce };
    }
    held.add(index);
  }
  return null;
}

// Polls `tryAcquireSlot` until `waitMs` ends. A slot won at or after the bound, for example by a
// pass that a stale reclaim slowed, is freed unused. A `waitMs` of 0 is one pass with no bound
// check. Returns the slot, or null at the bound or on an abort. The caller starts the command
// with no further await, so the bound check is the last step before the start.
async function acquireSlot({ root, slots, waitMs, signal }) {
  const deadline = Date.now() + waitMs;
  let waiting = false;
  for (;;) {
    const slot = await tryAcquireSlot(root, slots);
    if (slot && ((waitMs > 0 && Date.now() >= deadline) || signal.aborted)) {
      await slot.release();
      return null;
    }
    if (slot) {
      return slot;
    }
    const left = deadline - Date.now();
    if (left <= 0 || signal.aborted) {
      return null;
    }
    if (!waiting) {
      waiting = true;
      logInfo(`waiting for a test slot (${slots} in ${root}, bound ${waitMs / 1000}s)`);
    }
    try {
      await delay(Math.min(left, POLL_MS + Math.random() * POLL_MS), undefined, { signal });
    } catch {
      return null;
    }
  }
}

// True when any slot file under `root` is held by a live owner. A missing directory holds none.
// Reads only, with no table lock, so a slot taken right after the read is not seen.
async function anySlotHeld(root) {
  let entries;
  try {
    entries = await readdir(root);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
  for (const entry of entries) {
    if (SLOT_FILE.test(entry) && (await lockHeld(join(root, entry)))) {
      return true;
    }
  }
  return false;
}

// True when `marker` names a slot file that still holds the named nonce and a live owner.
async function heldByParent(marker) {
  try {
    const { lock, nonce } = JSON.parse(marker);
    if (typeof lock !== "string" || typeof nonce !== "string") {
      return false;
    }
    const owner = await readLockOwner(lock);
    return owner?.nonce === nonce && (await ownerAlive(owner));
  } catch {
    return false;
  }
}

/**
 * Holds a test slot for one command (ADR 0039, ADR 0040). Resolves `{ env, nested, release }`:
 * `env` holds the marker for the command, and `release` frees the slot. A valid parent marker in
 * `process.env` gives `nested: true`, no `env`, and nothing to free, so the command runs at once
 * in the slot of the parent. Resolves null at the wait bound or on an abort of `signal`, with no
 * slot held. Throws when the slot directory cannot be used. With `ifHeld` and no slot held by a
 * live owner, resolves `{ env: undefined, nested: false, release }` with no slot taken, so the
 * command runs directly (ADR 0044).
 */
export async function holdTestSlot({ slots, waitSeconds, signal, ifHeld = false }) {
  const marker = process.env[HELD_ENV];
  if (marker && (await heldByParent(marker))) {
    logDebug("a parent wrapper holds a test slot; running the command directly");
    return { env: undefined, nested: true, release: async () => {} };
  }
  if (marker) {
    logWarn(`ignoring ${HELD_ENV}: it names no test slot that a live wrapper holds`);
  }
  if (ifHeld && !(await anySlotHeld(slotsRoot()))) {
    logInfo("no test slot is held; running the command directly");
    return { env: undefined, nested: false, release: async () => {} };
  }
  const slot = await acquireSlot({ root: slotsRoot(), slots, waitMs: waitSeconds * 1000, signal });
  if (slot === null) {
    return null;
  }
  logInfo(`test slot ${slot.index} acquired`);
  return {
    env: { [HELD_ENV]: JSON.stringify({ lock: slot.lockFile, nonce: slot.nonce }) },
    nested: false,
    release: async () => {
      await slot.release();
      logInfo(`test slot ${slot.index} released`);
    },
  };
}

const signalExit = (name) => 128 + (constants.signals[name] ?? 0);

// Runs the command with the `--test-cmd` runner semantics: the platform shell, and a tree that
// `killLiveTrees` ends. A top-level run leads a process group of its own on POSIX. A nested run
// (`ownGroup` false) stays in the group of the outer wrapper's command, so the outer kill
// reaches it. The command text is never logged.
async function runCommand(command, { env, ownGroup }) {
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
      killDescendants: ownGroup,
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
  // A run that a signal reached exits with the code of that signal, whatever the killed command
  // returned.
  const run = async (env, ownGroup) => {
    const code = received ? null : await runCommand(options.command, { env, ownGroup });
    return received ? signalExit(received) : code;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    let slot;
    try {
      slot = await holdTestSlot({ ...options, signal: controller.signal });
    } catch (err) {
      logError(`test slot acquisition failed; the command did not run: ${err?.message ?? err}`);
      return 1;
    }
    if (slot === null) {
      if (received) {
        return signalExit(received);
      }
      logError(`no test slot won within ${options.waitSeconds}s; the command did not run`);
      return TEST_SLOT_TIMEOUT_EXIT;
    }
    try {
      return await run(slot.env, !slot.nested);
    } finally {
      await slot.release();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
