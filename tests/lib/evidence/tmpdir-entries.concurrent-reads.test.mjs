import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  appearedInInheritedTmpdir,
  snapshotInheritedTmpdir,
} from "../../../src/lib/evidence/tmpdir-entries.mjs";
import { removePath } from "../../fs-helpers.mjs";

// Registry checks in flight at once, held until the test releases them. 40 entries exceed the
// 32-call batch, so the bound leaves 8 checks for a second batch.
const checks = vi.hoisted(() => {
  const state = {
    inFlight: 0,
    peak: 0,
    started: [],
    held: [],
    signalFull: () => {},
    full: Promise.resolve(),
    signalAllStarted: () => {},
    allStarted: Promise.resolve(),
  };
  let fullSent = false;
  let allStartedSent = false;
  state.reset = () => {
    state.inFlight = 0;
    state.peak = 0;
    state.started = [];
    state.held = [];
    fullSent = false;
    allStartedSent = false;
    state.full = new Promise((resolve) => {
      state.signalFull = resolve;
    });
    state.allStarted = new Promise((resolve) => {
      state.signalAllStarted = resolve;
    });
  };
  state.hold = (name) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    state.started.push(name);
    if (!fullSent && state.inFlight >= 32) {
      fullSent = true;
      state.signalFull();
    }
    if (!allStartedSent && state.started.length === 40) {
      allStartedSent = true;
      state.signalAllStarted();
    }
    return new Promise((resolve) => {
      state.held.push(() => {
        state.inFlight -= 1;
        resolve(true);
      });
    });
  };
  state.releaseAll = () => {
    const held = state.held;
    state.held = [];
    for (const release of held) release();
  };
  state.reset();
  return state;
});
vi.mock("../../../src/lib/turn-tmpdir-registry.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  isRegisteredTurnTmpdir: async (_parent, name) => checks.hold(name),
}));

const NAMES = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, "0")}`);

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "entries-concurrent-"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
  checks.reset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removePath(root);
});

// Usefulness: verifies that at most a batch of registry checks is in flight (issue #1470). The
// 20-name report keeps its order and registered/ prefix for the same input.
test("bounds the registry checks in flight and keeps the report", async () => {
  const before = await snapshotInheritedTmpdir({ literalRoots: [] });
  for (const name of NAMES) await mkdir(join(root, name));

  const pending = appearedInInheritedTmpdir(before);
  await checks.full;
  checks.releaseAll();
  await checks.allStarted;
  const peak = checks.peak;
  checks.releaseAll();
  const report = await pending;

  const expected = NAMES.slice(0, 20).map((name) => `registered/${name}`);
  expect(peak).toBe(32);
  expect(report).toEqual(expected);
});
