// Machine-wide test slot (#847, ADR 0039). Claims one of the slot lock files that every work
// tree and project of the OS user on the host shares. Parallel full-suite runs then do not
// oversubscribe the host. The `test-slot` command lives in `test-slot-cli.mjs`.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readableErrorText } from "./error-message.mjs";
import { logDebug, logInfo, logWarn } from "./log.mjs";
import { ownerAlive } from "./process-identity.mjs";
import { slotsRoot } from "./slots-root.mjs";
import { lockHeld, readLockOwner, tryStateLock } from "./state-lock.mjs";

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

export const usageError = (message) => Object.assign(new Error(message), { usage: true });

export function slotCount(value, name) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw usageError(`${name} must be a positive integer, got "${value}".`);
  }
  return Number(value);
}

export function waitSeconds(value, name) {
  const seconds = Number(value);
  if (value.trim() === "" || !Number.isFinite(seconds) || seconds < 0) {
    throw usageError(`${name} must be a number of seconds of 0 or more, got "${value}".`);
  }
  return seconds;
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

// One pass under the short `acquire.lock`: counts the slot files held by live owners and, while
// fewer than `slots` are held, takes the lowest free index (`tryStateLock` reclaims a dead
// owner's file). Returns `{ index, lockFile, release, nonce }`, or null when the pass wins no slot.
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
    throw new AggregateError(errors, errors.map((err) => readableErrorText(err)).join("; "));
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  return slot;
}

// The indexes of the slot files that a live owner holds (`lockHeld`: an unreadable file counts, a
// stale one does not). Throws when `root` cannot be read.
async function heldSlotIndexes(root) {
  const held = new Set();
  for (const entry of await readdir(root)) {
    const match = SLOT_FILE.exec(entry);
    if (match && (await lockHeld(join(root, entry)))) {
      held.add(Number(match[1]));
    }
  }
  return held;
}

// Counts the held slot files and, while fewer than `slots` are held, takes the lowest free index.
// Runs under the table lock.
async function claimSlot(root, slots) {
  const held = await heldSlotIndexes(root);
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
      return { index, lockFile, release, nonce: release.nonce };
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
  try {
    return (await heldSlotIndexes(root)).size > 0;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
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
