import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearTimeout as realClearTimeout, setTimeout as realSetTimeout } from "node:timers";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";

const hashing = vi.hoisted(() => ({
  stall: false,
  failing: new Set(),
  captureSignal: false,
  signals: [],
  releaseFirstStart: null,
}));
// The dependency file list read: `fail` throws, and `stall` waits for the bound signal.
// `releaseStart` fires when a list read starts, and `output` is a controlled list result.
const gitList = vi.hoisted(() => ({
  fail: false,
  stall: false,
  output: null,
  releaseStart: null,
}));
vi.mock("../../src/lib/git-read.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    gitRead: async (cwd, args, options = {}) => {
      if (args?.[0] === "ls-files") {
        gitList.releaseStart?.();
        gitList.releaseStart = null;
        if (gitList.fail) throw new Error("git ls-files failed");
        if (gitList.stall) {
          return new Promise((_, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            });
          });
        }
        if (gitList.output !== null) return { stdout: gitList.output };
      }
      return actual.gitRead(cwd, args, options);
    },
  };
});
// null reads the real work tree root. 0 resolves at once, and another number waits that many real
// milliseconds, so no case waits on `git`.
const roots = vi.hoisted(() => ({ delayMs: null }));
vi.mock("../../src/lib/snapshot.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // The temp repo passed by these cases is its own root, so the double resolves `cwd`. A read
    // with its own `timeoutMs` ends at that shorter bound, as the real `workTreeRoot` does.
    workTreeRoot: (cwd, options = {}) => {
      if (roots.delayMs === null) return actual.workTreeRoot(cwd, options);
      if (roots.delayMs === 0) return Promise.resolve(cwd);
      return new Promise((resolve, reject) => {
        let deadline;
        const timer = realSetTimeout(() => {
          realClearTimeout(deadline);
          resolve(cwd);
        }, roots.delayMs);
        if (options.timeoutMs > 0) {
          deadline = realSetTimeout(() => {
            realClearTimeout(timer);
            reject(
              new Error(`git rev-parse --show-toplevel timed out after ${options.timeoutMs} ms`),
            );
          }, options.timeoutMs);
        }
      });
    },
    sha256File: (path, options) => {
      if (hashing.captureSignal) {
        hashing.signals.push(options?.signal);
        hashing.releaseFirstStart?.();
        hashing.releaseFirstStart = null;
        return new Promise(() => {});
      }
      if (hashing.stall) return new Promise(() => {});
      if ([...hashing.failing].some((name) => path.endsWith(name))) {
        return Promise.reject(Object.assign(new Error(`busy: ${path}`), { code: "EBUSY" }));
      }
      return actual.sha256File(path);
    },
  };
});

const { diffLockfiles, readLockfiles } = await import("../../src/lib/lockfile-change.mjs");

// A case creates the repository it needs, so a case that reads no Git path starts no process
// and its hooks carry no Git work.
let repo;
beforeEach(async () => {
  repo = undefined;
});
afterEach(async () => {
  hashing.stall = false;
  hashing.captureSignal = false;
  hashing.signals.length = 0;
  hashing.failing.clear();
  hashing.releaseFirstStart = null;
  gitList.fail = false;
  gitList.stall = false;
  gitList.output = null;
  gitList.releaseStart = null;
  roots.delayMs = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (repo) await removePath(repo);
  repo = undefined;
});

// Bounds the wait for the first hash read, so a stalled start fails by name, not at the test timeout.
const START_GUARD_MS = 10_000;
// Bounds the cleanup of a failed start: the released bound aborts its wait, and the read settles.
const SETTLE_GUARD_MS = 5_000;

// Releases the bound of a failed start and waits, with a bound, for the read to settle.
async function releasePendingRead(pending) {
  await vi.advanceTimersByTimeAsync(200);
  let timer;
  const expired = new Promise((resolve) => {
    timer = realSetTimeout(() => resolve("unsettled"), SETTLE_GUARD_MS);
  });
  try {
    const outcome = await Promise.race([pending.then(() => "settled"), expired]);
    if (outcome !== "settled") {
      throw new Error(`the lockfile read did not settle within ${SETTLE_GUARD_MS} ms`);
    }
  } finally {
    realClearTimeout(timer);
  }
}

// Holds the bound until the first hash read starts, so a slow root read cannot end it before a
// signal is recorded. A read that settles first, or a start past the guard, fails with the cause.
// `rootDelayMs` makes the root read take that many real milliseconds, so a case need not wait on
// `git` and a read past the bound is repeatable.
async function startHashRead({ rootDelayMs = 0 } = {}) {
  roots.delayMs = rootDelayMs;
  vi.useFakeTimers();
  const firstStart = new Promise((resolve) => {
    hashing.releaseFirstStart = resolve;
  });
  const pending = readLockfiles(repo, { boundMs: 200 });
  let guard;
  const guardExpired = new Promise((resolve) => {
    guard = realSetTimeout(() => resolve("stalled"), START_GUARD_MS);
  });
  let outcome;
  try {
    outcome = await Promise.race([
      firstStart.then(() => "started"),
      pending.then(() => "settled"),
      guardExpired,
    ]);
  } finally {
    realClearTimeout(guard);
  }
  if (outcome === "settled") {
    await releasePendingRead(pending);
    throw new Error("the lockfile read ended before any hash read started");
  }
  if (outcome === "stalled") {
    await releasePendingRead(pending);
    throw new Error(`no hash read started within ${START_GUARD_MS} ms`);
  }
  return {
    releaseBound: async () => {
      await vi.advanceTimersByTimeAsync(200);
      await pending;
    },
  };
}

// Usefulness: verifies requirement "a stalled lockfile read ends at the bound" (issue #1180): a hang
// would hold the worker turn after a cancel. A lockfile whose hash did not end in time is reported,
// never read as absent.
test("a stalled lockfile hash read ends at the bound and reports every lockfile", async () => {
  repo = await mkdtemp(join(tmpdir(), "lockfile-change-"));
  // The root and list reads are answered without `git`, so the case starts no process; the
  // stalled hash read is its subject.
  roots.delayMs = 0;
  gitList.output = "";
  const before = await readLockfiles(repo);
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  hashing.stall = true;
  const started = Date.now();
  const after = await readLockfiles(repo, { boundMs: 200 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(diffLockfiles(before, after)).toContain("pnpm-lock.yaml");
  expect(warn.mock.calls.some((call) => String(call[0]).includes("lockfile"))).toBe(true);
});

// Usefulness: verifies requirement "no timer shorter than the 200 ms bound ends the root read"
// (issue #1440): a root read slower than the bound in real time must still start a hash read, or
// the two cases below fail under load. A root-read timer at the bound fails this case by name.
test("a root read slower than the bound in real time still starts a hash read", async () => {
  repo = await createTempRepo();
  vi.spyOn(console, "error").mockImplementation(() => {});
  hashing.captureSignal = true;
  const read = await startHashRead({ rootDelayMs: 300 });
  expect(hashing.signals.length).toBeGreaterThan(0);
  await read.releaseBound();
  expect(hashing.signals.every((signal) => signal?.aborted === true)).toBe(true);
});

// Usefulness: verifies requirement "the bound aborts the signal of a hash read" (issue #1225), so a
// read that has not started its request stops. It shows the signal, not release of an open handle.
test("a hash read still pending at the bound receives an aborted signal", async () => {
  repo = await createTempRepo();
  vi.spyOn(console, "error").mockImplementation(() => {});
  hashing.captureSignal = true;
  const read = await startHashRead();
  expect(hashing.signals.length).toBeGreaterThan(0);
  await read.releaseBound();
  expect(hashing.signals.every((signal) => signal?.aborted === true)).toBe(true);
});

// Usefulness: verifies requirement "the bound aborts with its named reason" (#1269): the helper
// shared by three reads must not change the lockfile read's abort reason.
test("the bound aborts a pending hash read with the lockfile read reason", async () => {
  repo = await createTempRepo();
  vi.spyOn(console, "error").mockImplementation(() => {});
  hashing.captureSignal = true;
  const read = await startHashRead();
  expect(hashing.signals.length).toBeGreaterThan(0);
  await read.releaseBound();
  const reason = hashing.signals[0].reason;
  expect(reason).toBeInstanceOf(Error);
  expect(reason.message).toBe("lockfile read took over 200 ms");
});

// Usefulness: verifies requirement "an unread work tree root reaches the parent" (issue #1225): the
// parent reads only the envelope, so a null read would look like "no change". An unread root counts
// as changed for every lockfile, like an unreadable lockfile.
test("an unread work tree root reports every lockfile as changed", async () => {
  repo = await createTempRepo();
  const before = await readLockfiles(repo);
  const outside = await mkdtemp(join(tmpdir(), "agent-loops-no-repo-"));
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const after = await readLockfiles(outside);
    expect(after).not.toBeNull();
    expect(diffLockfiles(before, after)).toEqual([
      "bun.lock",
      "bun.lockb",
      "npm-shrinkwrap.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("lockfile"))).toBe(true);
  } finally {
    await removePath(outside);
  }
});

// Usefulness: verifies requirement "a lockfile that cannot be read is reported as changed" (issue
// #1180): the parent reads only the envelope, so a warning alone would leave an edited lockfile with
// no reinstall signal. A reinstall is harmless and a missed one is the failure the field targets.
test("an edited lockfile whose hash read fails is still reported", async () => {
  repo = await createTempRepo();
  const before = await readLockfiles(repo);
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  hashing.failing.add("pnpm-lock.yaml");
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const after = await readLockfiles(repo);
  expect(diffLockfiles(before, after)).toEqual(["pnpm-lock.yaml"]);
  expect(warn.mock.calls.some((call) => String(call[0]).includes("EBUSY"))).toBe(true);
});

// Usefulness: verifies the same when the read before the turn failed, so a lockfile with an unknown
// start state is reported too.
test("a lockfile whose hash read failed before the turn is reported", async () => {
  repo = await createTempRepo();
  hashing.failing.add("pnpm-lock.yaml");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const before = await readLockfiles(repo);
  hashing.failing.clear();
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual(["pnpm-lock.yaml"]);
});

// Usefulness: verifies an unread lockfile state is never compared, so a failed read reports no change.
test("two lockfile reads that failed report no change", () => {
  expect(diffLockfiles(null, null)).toEqual([]);
});

// Usefulness: verifies a non-Node dependency file in a subdirectory reports its change, so the
// parent reinstalls the right toolchain. An unchanged file stays out of the field.
test("a subdirectory requirements file reports only a real change", async () => {
  repo = await createTempRepo();
  await mkdir(join(repo, "sub"), { recursive: true });
  await writeFile(join(repo, "sub", "requirements.txt"), "one\n");
  const before = await readLockfiles(repo);
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual([]);
  await writeFile(join(repo, "sub", "requirements.txt"), "two\n");
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual(["sub/requirements.txt"]);
});

// Usefulness: verifies an added and a deleted dependency file both reach the field, so neither
// change is lost when the two sides list different paths.
test("an added and a deleted dependency file are both reported", async () => {
  repo = await createTempRepo();
  await writeFile(join(repo, "constraints.txt"), "one\n");
  await mkdir(join(repo, "sub"), { recursive: true });
  await writeFile(join(repo, "sub", "poetry.lock"), "one\n");
  const before = await readLockfiles(repo);
  await rm(join(repo, "constraints.txt"));
  await mkdir(join(repo, "app"), { recursive: true });
  await writeFile(join(repo, "app", "Pipfile.lock"), "one\n");
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual([
    "app/Pipfile.lock",
    "constraints.txt",
  ]);
});

// Usefulness: verifies an ignored dependency file is never read, while a tracked-path change is.
// The ignored directory holds a matching name, so a list read without the exclude rule fails.
test("an ignored dependency file is not reported", async () => {
  repo = await createTempRepo();
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  await mkdir(join(repo, "ignored"), { recursive: true });
  await writeFile(join(repo, "ignored", "requirements.txt"), "one\n");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "requirements.txt"), "one\n");
  const before = await readLockfiles(repo);
  await writeFile(join(repo, "ignored", "requirements.txt"), "two\n");
  await writeFile(join(repo, "src", "requirements.txt"), "two\n");
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual(["src/requirements.txt"]);
});

// Usefulness: verifies a look-alike name stays out of the field, while a listed name is reported.
// A substring match must not report requirements.md or my-poetry.lock.
test("a file name that only resembles the list is not reported", async () => {
  repo = await createTempRepo();
  await writeFile(join(repo, "requirements.md"), "one\n");
  await mkdir(join(repo, "sub"), { recursive: true });
  await writeFile(join(repo, "sub", "my-poetry.lock"), "one\n");
  await writeFile(join(repo, "poetry.lock"), "one\n");
  const before = await readLockfiles(repo);
  await writeFile(join(repo, "requirements.md"), "two\n");
  await writeFile(join(repo, "sub", "my-poetry.lock"), "two\n");
  await writeFile(join(repo, "poetry.lock"), "two\n");
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual(["poetry.lock"]);
});

// Usefulness: verifies hostile path names are read through -z and reported exactly, so a space,
// a non-ASCII character, or a newline cannot change which file the parent sees.
test("a hostile dependency path is reported exactly", async () => {
  repo = await createTempRepo();
  const paths = ["sub dir/requirements dev.txt", "sub-é/requirements.txt"];
  if (process.platform !== "win32") paths.push("sub\nline/requirements.txt");
  for (const path of paths) {
    await mkdir(join(repo, dirname(path)), { recursive: true });
    await writeFile(join(repo, ...path.split("/")), "one\n");
  }
  const before = await readLockfiles(repo);
  for (const path of paths) {
    await writeFile(join(repo, ...path.split("/")), "two\n");
  }
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual([...paths].sort());
});

// Usefulness: verifies a failed dependency file list reports every known dependency path, so a
// list failure never reads as no change.
test("a failed dependency file list reports every known path", async () => {
  repo = await createTempRepo();
  await mkdir(join(repo, "sub"), { recursive: true });
  await writeFile(join(repo, "sub", "requirements.txt"), "one\n");
  const before = await readLockfiles(repo);
  gitList.fail = true;
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const after = await readLockfiles(repo);
  expect(diffLockfiles(before, after)).toEqual([
    "bun.lock",
    "bun.lockb",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "sub/requirements.txt",
    "yarn.lock",
  ]);
  expect(
    warn.mock.calls.some((call) => String(call[0]).includes("dependency file list read failed")),
  ).toBe(true);
  expect(warn.mock.calls.every((call) => !String(call[0]).includes("sub/requirements.txt"))).toBe(
    true,
  );
});

// Usefulness: verifies a dependency file list read past the bound fails closed, so a timeout
// never reads as no change.
test("a dependency file list read past the bound reports every known path", async () => {
  repo = await mkdtemp(join(tmpdir(), "lockfile-change-"));
  await mkdir(join(repo, "sub"), { recursive: true });
  await writeFile(join(repo, "sub", "requirements.txt"), "one\n");
  gitList.output = "sub/requirements.txt\0";
  roots.delayMs = 0;
  const before = await readLockfiles(repo);
  gitList.stall = true;
  // Supply the root without a spawn or timer, and let the bound wait for the list read to start.
  vi.useFakeTimers();
  const listStarted = new Promise((resolve) => {
    gitList.releaseStart = resolve;
  });
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const started = Date.now();
  const pending = readLockfiles(repo, { boundMs: 100 });
  await listStarted;
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(100);
  const after = await pending;
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(diffLockfiles(before, after)).toEqual([
    "bun.lock",
    "bun.lockb",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "sub/requirements.txt",
    "yarn.lock",
  ]);
  expect(
    warn.mock.calls.some((call) => String(call[0]).includes("dependency file list read failed")),
  ).toBe(true);
});

// Usefulness: verifies the dependency file cap reports the overflow, so a silent no change cannot
// hide a file above the cap.
test("dependency files above the cap are reported as changed", async () => {
  repo = await createTempRepo();
  const many = join(repo, "many");
  await mkdir(many, { recursive: true });
  const names = Array.from(
    { length: 257 },
    (_, index) => `requirements-${String(index).padStart(3, "0")}.txt`,
  );
  for (const name of names) await writeFile(join(many, name), "one\n");
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const before = await readLockfiles(repo);
  const after = await readLockfiles(repo);
  expect(diffLockfiles(before, after)).toEqual(["many/requirements-256.txt"]);
  expect(warn.mock.calls.some((call) => String(call[0]).includes("257"))).toBe(true);
});

// Usefulness: verifies every listed non-Node name matches at any depth, so a typo cannot leave
// one toolchain outside the field.
test("every listed non-Node dependency name is reported", async () => {
  repo = await createTempRepo();
  const names = [
    "requirements-dev.txt",
    "constraints-prod.txt",
    "Pipfile.lock",
    "poetry.lock",
    "pdm.lock",
    "uv.lock",
    "Cargo.lock",
    "go.sum",
    "Gemfile.lock",
    "composer.lock",
  ];
  for (const [index, name] of names.entries()) {
    const dir = join(repo, `tool-${index}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), "one\n");
  }
  const before = await readLockfiles(repo);
  for (const [index, name] of names.entries()) {
    await writeFile(join(repo, `tool-${index}`, name), "two\n");
  }
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual(
    names.map((name, index) => `tool-${index}/${name}`).sort(),
  );
});
