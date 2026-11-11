import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo } from "./git-helpers.mjs";

// The order in which the post-turn `git` reads start and end. `slowStatus` holds the end of the
// work tree status read until the shared Git read starts, as a large work tree does.
const reads = vi.hoisted(() => ({
  events: [],
  slowStatus: false,
  statusGate: Promise.resolve(),
  releaseStatus: () => {},
  resetStatusGate() {
    this.statusGate = new Promise((resolve) => {
      this.releaseStatus = resolve;
    });
  },
}));
vi.mock("../src/lib/exec.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execBounded: async (command, args, ...rest) => {
      if (command !== "git") return real.execBounded(command, args, ...rest);
      if (args.includes("--git-common-dir")) {
        reads.events.push("shared read started");
        reads.releaseStatus();
      }
      const result = await real.execBounded(command, args, ...rest);
      if (args[0] === "status" && reads.slowStatus) {
        await reads.statusGate;
        reads.events.push("work tree status ended");
      }
      return result;
    },
  };
});

// The post-turn reads of a failed turn hold until the test releases them, and record each start.
// `enabled` is set inside the adapter, after the pre-turn reads, so only the post-turn reads hold.
const holds = vi.hoisted(() => ({
  started: [],
  enabled: false,
  release: () => {},
  gate: Promise.resolve(),
  first: Promise.resolve(),
  signalFirst: () => {},
  reset() {
    this.started = [];
    this.enabled = false;
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    this.first = new Promise((resolve) => {
      this.signalFirst = resolve;
    });
  },
  start(name) {
    if (this.started.length === 0) this.signalFirst();
    this.started.push(name);
  },
}));
vi.mock("../src/lib/evidence/shared-git.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    readSharedGit: async (cwd, bound) => {
      if (holds.enabled && bound?.deadlineMs !== undefined) {
        holds.start("shared Git");
        await holds.gate;
      }
      return real.readSharedGit(cwd, bound);
    },
  };
});
vi.mock("../src/lib/evidence/lockfile-change.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    readLockfiles: async (...args) => {
      if (holds.enabled) {
        holds.start("lockfile");
        await holds.gate;
      }
      return real.readLockfiles(...args);
    },
  };
});
vi.mock("../src/lib/evidence/tmpdir-entries.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    appearedInInheritedTmpdir: async (...args) => {
      if (holds.enabled) {
        holds.start("advisory");
        await holds.gate;
      }
      return real.appearedInInheritedTmpdir(...args);
    },
  };
});

// Real Git: each turn reads the work tree of a real repository, so the snapshot matches Git.
let repo;
beforeEach(async () => {
  repo = await createTempRepo();
  holds.reset();
});
afterEach(async () => {
  holds.release();
  reads.slowStatus = false;
  reads.resetStatusGate();
  await removePath(repo);
});

// Usefulness: verifies the work tree read and the shared Git read of a worker turn run together
// (issue #1187), since neither depends on the other. The result of the turn is unchanged.
test("a worker turn reads the work tree and the shared Git state concurrently", async () => {
  const result = await runChild({
    agents: {
      fake: scripted([
        async () => {
          reads.events.length = 0;
          reads.resetStatusGate();
          reads.slowStatus = true;
          return "done";
        },
      ]),
    },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });
  expect(reads.events.indexOf("shared read started")).toBeGreaterThanOrEqual(0);
  expect(reads.events.indexOf("shared read started")).toBeLessThan(
    reads.events.indexOf("work tree status ended"),
  );
  expect(result.workTree).toMatchObject({ clean: true });
});

const runTurn = (act) =>
  runChild({
    agents: { fake: scripted([act]) },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  }).catch((err) => err);

// Usefulness: verifies requirement "the fatal path runs the three post-turn reads concurrently"
// (issue #1401). A sequential path starts only the first read, so the other two never start before
// the release.
test("a fatal turn starts the three post-turn reads together", async () => {
  const turn = runTurn(async () => {
    holds.enabled = true;
    throw Object.assign(new Error("fatal"), { name: "SnapshotError" });
  });
  await holds.first;
  await new Promise((resolve) => setImmediate(resolve));
  expect(holds.started).toEqual(["shared Git", "lockfile", "advisory"]);
  holds.release();
  expect(await turn).toMatchObject({ name: "SnapshotError" });
});

// Usefulness: verifies requirement "the handled-error path runs the three post-turn reads
// concurrently" (issue #1401). A sequential path starts only the first read, so the other two never
// start before the release.
test("a handled-error turn starts the three post-turn reads together", async () => {
  const turn = runTurn(async () => {
    holds.enabled = true;
    throw new Error("adapter failed");
  });
  await holds.first;
  await new Promise((resolve) => setImmediate(resolve));
  expect(holds.started).toEqual(["shared Git", "lockfile", "advisory"]);
  holds.release();
  expect(await turn).toMatchObject({ status: "error" });
});
