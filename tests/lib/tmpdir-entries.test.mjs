import {
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  appearedInInheritedTmpdir,
  pidIsAlive,
  presentInheritedTmpdir,
  presentInheritedTmpdirReport,
  probeHeldOpenWindows,
  readAncestorPids,
  settleInheritedTmpdirNames,
  snapshotInheritedTmpdir,
} from "../../src/lib/tmpdir-entries.mjs";
import { withTurnTmpdir } from "../../src/lib/turn-tmpdir.mjs";
import { exists, removePath } from "../fs-helpers.mjs";

let root;
let runsRoot;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "entries-"));
  // Outside `root`, so the host-wide registry of turn directories is no entry of the listed one.
  runsRoot = await mkdtemp(join(tmpdir(), "entries-runs-"));
  vi.stubEnv("AGENT_LOOP_RUNS_ROOT", runsRoot);
  // `tmpdir()` reads these at call time, so the library lists the private directory.
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removePath(root);
  await removePath(runsRoot);
});

// A fresh module instance has its own set of created names, like another agent-loop process.
async function anotherProcess() {
  vi.resetModules();
  return import("../../src/lib/turn-tmpdir.mjs");
}

// Usefulness: verifies requirement "report the entries that appeared directly in the inherited
// temporary directory during a turn" (issue #1024), and that an entry present before is not one.
test("lists only entries that appeared after the snapshot", async () => {
  await mkdir(join(root, "old-probe"));
  const before = await snapshotInheritedTmpdir();
  await mkdir(join(root, "m54-3db54ca8"));
  expect(await appearedInInheritedTmpdir(before)).toEqual(["m54-3db54ca8"]);
});

// Usefulness: verifies requirement "a file that is gone at the settle re-read does not appear in
// inheritedTmpdirEntries" (issue #1542): the transient file exists for the post-turn read, and the
// settle step removes it before the confirming read, so the ordering is fixed and no wall-clock
// wait decides it. A file that stays is still listed.
test("leaves out a file that is gone at the settle read and keeps one that stays", async () => {
  const before = await snapshotInheritedTmpdir();
  await writeFile(join(root, "stays.txt"), "");
  const transient = join(root, "4a09873d-cff3-4dee-98a7-9f6f98072662.tmp");
  await writeFile(transient, "");
  const entries = await appearedInInheritedTmpdir(before, {
    settle: async () => {
      expect(await exists(transient)).toBe(true);
      await rm(transient);
    },
  });
  expect(entries).toEqual(["stays.txt"]);
});

// Usefulness: verifies requirement "only the runtime's own turn directories are left out" (issue
// #1024): the directory that `withTurnTmpdir` created is not reported while it exists, and an
// unmanaged `al-` directory that a reviewer created is, so the prefix alone hides nothing.
test("leaves out the directory the runtime created and reports an unmanaged al- directory", async () => {
  const before = await snapshotInheritedTmpdir();
  await mkdir(join(root, "al-probe"));
  const seen = await withTurnTmpdir(async (env) => {
    expect(env).toBeDefined();
    return appearedInInheritedTmpdir(before);
  });
  expect(seen).toEqual(["al-probe"]);
});

// Usefulness: verifies requirement "a directory the runtime did not remove is reportable" (issue
// #1024): when the turn directory is renamed and its path recreated, the removal refuses the
// replacement by identity, and that replacement must not stay excluded by its name.
test("reports a replacement of the turn directory that the removal refused", async () => {
  const before = await snapshotInheritedTmpdir();
  let name;
  await withTurnTmpdir(async (env) => {
    name = basename(env.TMPDIR);
    await rename(env.TMPDIR, join(root, "moved-away"));
    await mkdir(env.TMPDIR);
  });
  const entries = await appearedInInheritedTmpdir(before);
  expect(entries).toContain(name);
});

// Usefulness: verifies requirement "a secret-named environment value in a name is redacted" (issue
// #1024, ADR 0017): a reviewer-chosen name can echo a value the process holds, and the list reaches
// the envelope, the state file, and the headless prompt.
test("redacts the value of a secret-named environment variable in a name", async () => {
  vi.stubEnv("PROBE_API_TOKEN", "s3cr3t-value-9402");
  const before = await snapshotInheritedTmpdir();
  await mkdir(join(root, "probe-s3cr3t-value-9402"));
  const entries = await appearedInInheritedTmpdir(before);
  expect(entries).toEqual(["probe-[redacted:PROBE_API_TOKEN]"]);
  expect(JSON.stringify(entries)).not.toContain("s3cr3t-value-9402");
});

// Usefulness: verifies requirement "an unreadable directory reports nothing instead of a false
// change", as a missing before-state would otherwise read as every entry new.
test("reports nothing when the snapshot could not be read", async () => {
  vi.stubEnv("TMPDIR", join(root, "missing"));
  vi.stubEnv("TEMP", join(root, "missing"));
  vi.stubEnv("TMP", join(root, "missing"));
  const before = await snapshotInheritedTmpdir();
  expect(before).toBeNull();
  expect(await appearedInInheritedTmpdir(before)).toEqual([]);
});

// Usefulness: verifies requirement "the field stays bounded" so a busy host cannot flood the envelope.
test("lists at most 20 names", async () => {
  const before = await snapshotInheritedTmpdir();
  for (let i = 0; i < 25; i += 1) await mkdir(join(root, `p${String(i).padStart(2, "0")}`));
  expect(await appearedInInheritedTmpdir(before)).toHaveLength(20);
});

// Usefulness: verifies requirement "a reviewer turn tells the turn directory of a concurrent run
// apart" (issue #1240): the directory is registered by a process other than the one that reads the
// list, so the exact-name set of the reader cannot cover it, and the entry stays visible, marked.
test("marks the turn directory that another process created and keeps it listed", async () => {
  const other = await anotherProcess();
  const before = await snapshotInheritedTmpdir();
  let name;
  const seen = await other.withTurnTmpdir(async (env) => {
    name = basename(env.TMPDIR);
    return appearedInInheritedTmpdir(before);
  });
  expect(seen).toEqual([`registered/${name}`]);
});

// Usefulness: verifies requirement "an al- name that no agent-loop process created is reported as
// before" (issue #1240) next to a registered one, so the pattern alone marks nothing.
test("lists an al- directory that no process registered without a mark", async () => {
  const other = await anotherProcess();
  const before = await snapshotInheritedTmpdir();
  await mkdir(join(root, "al-Zq81xT"));
  const seen = await other.withTurnTmpdir(async () => appearedInInheritedTmpdir(before));
  expect(seen).toContain("al-Zq81xT");
});

// Usefulness: verifies requirement "no turn can remove an entry from the report by writing a record"
// (issue #1240, ADR 0068 decision 4, ADR 0069): a record that a turn forges for its own directory
// at most adds a mark, and the entry stays listed.
test("keeps a directory listed when a turn forges a registration for it", async () => {
  const before = await snapshotInheritedTmpdir();
  const dir = join(root, "al-Ab1234");
  await mkdir(dir);
  const { dev, ino } = await stat(dir, { bigint: true });
  await mkdir(join(runsRoot, "turn-tmpdirs"), { recursive: true });
  await writeFile(join(runsRoot, "turn-tmpdirs", "al-Ab1234"), `${dev}:${ino}`);
  const entries = await appearedInInheritedTmpdir(before);
  expect(entries.some((entry) => entry.endsWith("al-Ab1234"))).toBe(true);
});

// Usefulness: verifies acceptance. A name gone at a later read is left out, and a name that stays
// is kept. A name removed and created again counts as present (issue #1559). The ordering is fixed
// by the files, so no wall-clock wait decides it.
test("reports only the recorded names that a later read still holds", async () => {
  const gone = join(root, "4a09873d-cff3-4dee-98a7-9f6f98072662.tmp");
  const stays = join(root, "stays.txt");
  const again = join(root, "created-again.txt");
  await writeFile(gone, "");
  await writeFile(stays, "");
  await writeFile(again, "");
  await rm(gone);
  await rm(again);
  await writeFile(again, "");
  expect(
    await presentInheritedTmpdir([
      "4a09873d-cff3-4dee-98a7-9f6f98072662.tmp",
      "stays.txt",
      "created-again.txt",
    ]),
  ).toEqual(["stays.txt", "created-again.txt"]);
});

// Usefulness: verifies requirement "a failed or over-bound later read keeps every recorded name"
// (issue #1559). The list is advisory, so a lost name can hide a leftover.
test("keeps every recorded name when the later read fails or passes its bound", async () => {
  const recorded = ["a.tmp", "b.tmp"];
  expect(
    await presentInheritedTmpdir(recorded, {
      read: async () => {
        throw new Error("EACCES");
      },
    }),
  ).toEqual(recorded);
  expect(
    await presentInheritedTmpdir(recorded, { read: () => new Promise(() => {}), boundMs: 10 }),
  ).toEqual(recorded);
});

// Usefulness: verifies acceptance. A name removed during the wait returns before the bound, so a
// transient GUID `.tmp` file stays out of the finish summary (issue #1569).
test("returns before the bound once every recorded name is gone", async () => {
  let reads = 0;
  let clock = 0;
  const result = await presentInheritedTmpdir(["gone.tmp"], {
    read: async () => {
      reads += 1;
      return reads === 1 ? ["gone.tmp"] : [];
    },
    settle: {
      boundMs: 60_000,
      intervalMs: 5_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  });
  expect(result).toEqual([]);
  expect(reads).toBe(2);
  expect(clock).toBeLessThan(60_000);
});

// Usefulness: verifies acceptance. A name that stays until the final read is reported. The final
// read starts early enough that its bound ends by the deadline (issue #1569).
test("reports a name that stays until the final read", async () => {
  let clock = 0;
  let reads = 0;
  const result = await presentInheritedTmpdir(["stays.tmp"], {
    read: async () => {
      reads += 1;
      return ["stays.tmp"];
    },
    settle: {
      boundMs: 30_000,
      intervalMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  });
  expect(result).toEqual(["stays.tmp"]);
  expect(clock).toBe(25_000);
  expect(clock).toBeLessThanOrEqual(30_000);
  expect(reads).toBe(4);
});

// Usefulness: verifies acceptance. A name that one read misses and a later read holds stays
// reported, so a recreated name never drops for good (issue #1569).
test("reports a name created again after a read missed it", async () => {
  let clock = 0;
  let reads = 0;
  const result = await presentInheritedTmpdir(["again.tmp", "stays.tmp"], {
    read: async () => {
      reads += 1;
      return reads === 1 ? ["stays.tmp"] : ["again.tmp", "stays.tmp"];
    },
    settle: {
      boundMs: 20,
      intervalMs: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  });
  expect(result).toEqual(["again.tmp", "stays.tmp"]);
  expect(reads).toBeGreaterThan(1);
});

// Usefulness: verifies acceptance. The whole command, every read included, ends by the bound, and
// the final read supplies the report (issue #1569).
test("ends the whole command by the bound", async () => {
  let clock = 0;
  let reads = 0;
  const result = await presentInheritedTmpdir(["final.tmp"], {
    read: async () => {
      reads += 1;
      clock += 5;
      return reads === 1 ? ["final.tmp"] : [];
    },
    settle: {
      boundMs: 10,
      intervalMs: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  });
  expect(result).toEqual([]);
  expect(reads).toBe(2);
  expect(clock).toBeLessThanOrEqual(10);
});

// Usefulness: verifies requirement "a later poll whose read fails keeps every name still listed"
// (issue #1569). A lost name can hide a leftover.
test("keeps every name still listed when a later poll fails", async () => {
  let clock = 0;
  let reads = 0;
  const result = await presentInheritedTmpdir(["a.tmp", "b.tmp"], {
    read: async () => {
      reads += 1;
      if (reads === 1) return ["a.tmp"];
      throw new Error("EACCES");
    },
    settle: {
      boundMs: 20,
      intervalMs: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  });
  expect(result).toEqual(["a.tmp"]);
  expect(reads).toBeGreaterThan(1);
});

// Usefulness: verifies an empty list returns at once, so a run with no reviewer name pays no wait
// (issue #1569).
test("returns at once for an empty name list", async () => {
  let read = false;
  let slept = false;
  expect(
    await presentInheritedTmpdir([], {
      read: async () => {
        read = true;
        return [];
      },
      settle: {
        sleep: async () => {
          slept = true;
        },
      },
    }),
  ).toEqual([]);
  expect(read).toBe(false);
  expect(slept).toBe(false);
});

// Usefulness: verifies a missing inherited directory keeps every name without a wait, because no
// later read can prove a name gone (issue #1569).
test("keeps every name when the inherited directory is missing", async () => {
  let slept = false;
  const result = await presentInheritedTmpdir(["a.tmp", "b.tmp"], {
    read: async () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    settle: {
      sleep: async () => {
        slept = true;
      },
    },
  });
  expect(result).toEqual(["a.tmp", "b.tmp"]);
  expect(slept).toBe(false);
});

// Usefulness: verifies a cancel during the default sleep ends at once with the cancel identity.
// Ctrl+C exits 130 without waiting for the interval or the bound (issue #1569).
test("a cancel ends the default sleep at once", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const pending = presentInheritedTmpdir(["a.tmp"], {
    read: async () => ["a.tmp"],
    settle: {
      boundMs: 60_000,
      intervalMs: 60_000,
      signal: controller.signal,
    },
  });
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toMatchObject({ isCanceled: true });
  expect(performance.now() - started).toBeLessThan(1_000);
});

// Usefulness: verifies a cancel during an in-flight read ends at once with the cancel identity, not
// after the read bound (issue #1569).
test("a cancel ends an in-flight read at once", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const pending = presentInheritedTmpdir(["a.tmp"], {
    read: () => new Promise(() => {}),
    settle: {
      boundMs: 60_000,
      intervalMs: 60_000,
      signal: controller.signal,
    },
  });
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toMatchObject({ isCanceled: true });
  expect(performance.now() - started).toBeLessThan(1_000);
});

// Usefulness: verifies a name that the read cannot check stays listed and adds no wait. A redacted
// or unsafe name never holds the command for the whole bound (issue #1569).
test("a name that cannot be checked adds no wait", async () => {
  let slept = false;
  const names = ["../outside.txt", "C:\\temp\\x"];
  expect(
    await presentInheritedTmpdir(names, {
      read: async () => [],
      settle: {
        sleep: async () => {
          slept = true;
        },
      },
    }),
  ).toEqual(names);
  expect(slept).toBe(false);
});

// Usefulness: verifies that the read never resolves a recorded name outside the inherited
// directory. A name with a separator or `..` stays listed, and no path is joined (issue #1559).
test("keeps a name that holds a separator or .. without resolving it", async () => {
  expect(
    await presentInheritedTmpdir(["../outside.txt"], { read: async () => ["outside.txt"] }),
  ).toEqual(["../outside.txt"]);
  expect(await presentInheritedTmpdir(["a/b"], { read: async () => ["a/b"] })).toEqual(["a/b"]);
  expect(await presentInheritedTmpdir([".."], { read: async () => [] })).toEqual([".."]);
});

// Usefulness: verifies requirement "a Windows-shaped recorded name is unsafe on every platform"
// (issue #1559). A backslash, a drive letter, and a UNC prefix never resolve a path and stay
// listed, whatever the read returns.
test("keeps a Windows-shaped name without resolving it", async () => {
  const names = ["a\\b", "C:name", "C:\\temp\\x", "\\\\server\\share\\x"];
  expect(await presentInheritedTmpdir(names, { read: async () => [] })).toEqual(names);
  expect(await presentInheritedTmpdir(names, { read: async () => ["C:name"] })).toEqual(names);
});

// Usefulness: verifies requirement "a name that carries the registered mark is re-checked by the
// entry name" (issue #1559). The mark is not part of the directory entry.
test("re-checks a registered name without its mark and keeps the mark", async () => {
  expect(
    await presentInheritedTmpdir(["registered/al-Ab1234", "registered/al-Gone"], {
      read: async () => ["al-Ab1234"],
    }),
  ).toEqual(["registered/al-Ab1234"]);
});

// Usefulness: verifies requirement "a registered name does not mark a different directory" (issue
// #1240): a turn directory that the removal refused and a reviewer replaced is listed without the
// mark, whichever process registered the name.
test("lists a replacement of the turn directory of another process without a mark", async () => {
  const other = await anotherProcess();
  const before = await snapshotInheritedTmpdir();
  let name;
  await other.withTurnTmpdir(async (env) => {
    name = basename(env.TMPDIR);
    await rename(env.TMPDIR, join(root, "moved-away"));
    await mkdir(env.TMPDIR);
    expect(await appearedInInheritedTmpdir(before)).toContain(name);
  });
  expect(await appearedInInheritedTmpdir(before)).toContain(name);
});

// Usefulness: verifies that a held Windows file is settled (issue #1600).
test("settles a Windows file that another process holds open", async () => {
  const held = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
  const result = await settleInheritedTmpdirNames([held, "stays.txt"], {
    platform: "win32",
    probe: async (name) => (name === held ? "held" : "free"),
  });
  expect(result).toEqual({ leftovers: ["stays.txt"], settled: [held] });
});

// Usefulness: verifies that a free Windows file stays reported (issue #1600).
test("keeps a Windows file that no process holds open", async () => {
  const name = "stays.txt";
  expect(
    await settleInheritedTmpdirNames([name], {
      platform: "win32",
      probe: async () => "free",
    }),
  ).toEqual({ leftovers: [name], settled: [] });
});

// Usefulness: verifies that an unsettled Windows probe keeps the name (issue #1600).
test("keeps a Windows name whose probe cannot settle it", async () => {
  const name = "a.tmp";
  expect(
    await settleInheritedTmpdirNames([name], {
      platform: "win32",
      probe: async () => "unknown",
    }),
  ).toEqual({ leftovers: [name], settled: [] });
});

// Usefulness: verifies that one probe error does not stop another probe (issue #1600).
test("keeps a Windows name whose probe throws and settles the next", async () => {
  const failing = "a.tmp";
  const held = "b.tmp";
  const result = await settleInheritedTmpdirNames([failing, held], {
    platform: "win32",
    probe: async (name) => {
      if (name === failing) throw new Error("EACCES");
      return "held";
    },
  });
  expect(result).toEqual({ leftovers: [failing], settled: [held] });
});

// Usefulness: verifies that a probe bound keeps the name reported (issue #1600).
test("keeps a Windows name when the probe reaches its bound", async () => {
  const name = "a.tmp";
  expect(
    await settleInheritedTmpdirNames([name], {
      platform: "win32",
      probe: () => new Promise(() => {}),
      boundMs: 5,
    }),
  ).toEqual({ leftovers: [name], settled: [] });
});

// Usefulness: verifies that a registered name is never settled (issue #1600).
test("keeps a registered name even when the probe reports a holder", async () => {
  const name = "registered/al-Ab1234";
  expect(
    await settleInheritedTmpdirNames([name], {
      platform: "win32",
      probe: async () => "held",
    }),
  ).toEqual({ leftovers: [name], settled: [] });
});

// Usefulness: verifies that Linux settles no name (issue #1600).
test("settles no name on Linux", async () => {
  const name = "a.tmp";
  expect(
    await settleInheritedTmpdirNames([name], {
      platform: "linux",
      probe: async () => "held",
    }),
  ).toEqual({ leftovers: [name], settled: [] });
});

// Usefulness: verifies that an open EBUSY settles a held Windows file (issue #1600).
test("probes a Windows file that another handle holds", async () => {
  expect(
    await probeHeldOpenWindows("held.tmp", {
      lstatFile: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
      openHandle: async () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    }),
  ).toBe("held");
});

// Usefulness: verifies that a free Windows file closes its handle (issue #1600).
test("probes a free Windows file and closes its handle", async () => {
  let closed = false;
  const outcome = await probeHeldOpenWindows("free.tmp", {
    lstatFile: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
    openHandle: async () => ({
      stat: async () => ({ dev: 1n, ino: 2n }),
      close: async () => {
        closed = true;
      },
    }),
  });
  expect(outcome).toBe("free");
  expect(closed).toBe(true);
});

// Usefulness: verifies that a handle identity mismatch keeps the name (issue #1600).
test("keeps a Windows file whose opened handle differs", async () => {
  let closed = false;
  const outcome = await probeHeldOpenWindows("swapped.tmp", {
    lstatFile: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
    openHandle: async () => ({
      stat: async () => ({ dev: 1n, ino: 3n }),
      close: async () => {
        closed = true;
      },
    }),
  });
  expect(outcome).toBe("unknown");
  expect(closed).toBe(true);
});

// Usefulness: verifies that a directory or link is not opened (issue #1600).
test("keeps a Windows directory and a link", async () => {
  expect(
    await probeHeldOpenWindows("entry", {
      lstatFile: async () => ({ isFile: () => false, isSymbolicLink: () => true }),
      openHandle: async () => {
        throw new Error("must not open");
      },
    }),
  ).toBe("unknown");
});

// Usefulness: verifies that a non-EBUSY open error keeps the name (issue #1600).
test("keeps a Windows name whose open fails otherwise", async () => {
  expect(
    await probeHeldOpenWindows("denied.tmp", {
      lstatFile: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
      openHandle: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
  ).toBe("unknown");
});

// Usefulness: verifies that EPERM means the pid is alive (issue #1600).
test("reads a live pid from EPERM", () => {
  expect(pidIsAlive(42, { kill: () => {} })).toBe(true);
  expect(
    pidIsAlive(42, {
      kill: () => {
        throw Object.assign(new Error("eperm"), { code: "EPERM" });
      },
    }),
  ).toBe(true);
  expect(
    pidIsAlive(42, {
      kill: () => {
        throw Object.assign(new Error("esrch"), { code: "ESRCH" });
      },
    }),
  ).toBe(false);
  expect(
    pidIsAlive(42, {
      kill: () => {
        throw new Error("other");
      },
    }),
  ).toBe(false);
});

const macGuid = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b";
const macPid = 4321;
const macBase = `${macGuid}-${macPid}-ab12cd`;
const macShm = `${macBase}-shm`;
const macWal = `${macBase}-wal`;
const regular = async () => ({ isFile: () => true });

// Usefulness: verifies that a live embedded pid settles a macOS pair (issue #1600).
test("settles a macOS pair whose embedded pid is alive", async () => {
  expect(
    await settleInheritedTmpdirNames([macShm, macWal], {
      platform: "darwin",
      ancestors: new Set([1, 2]),
      pidAlive: () => true,
      statFile: regular,
    }),
  ).toEqual({ leftovers: [], settled: [macShm, macWal] });
});

// Usefulness: verifies that a dead embedded pid keeps a macOS pair (issue #1600).
test("keeps a macOS pair whose embedded pid is dead", async () => {
  expect(
    await settleInheritedTmpdirNames([macShm, macWal], {
      platform: "darwin",
      ancestors: new Set([1, 2]),
      pidAlive: () => false,
      statFile: regular,
    }),
  ).toEqual({ leftovers: [macShm, macWal], settled: [] });
});

// Usefulness: verifies that a lone macOS member stays reported (issue #1600).
test("keeps a lone macOS shm name", async () => {
  expect(
    await settleInheritedTmpdirNames([macShm], {
      platform: "darwin",
      ancestors: new Set([1, 2]),
      pidAlive: () => true,
      statFile: async (path) => {
        if (path.endsWith(macWal)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return { isFile: () => true };
      },
    }),
  ).toEqual({ leftovers: [macShm], settled: [] });
});

// Usefulness: verifies that a malformed macOS name stays reported (issue #1600).
test("keeps a malformed macOS name", async () => {
  const names = [
    `not-a-guid-${macPid}-ab12cd-shm`,
    `${macGuid}-0-ab12cd-shm`,
    `${macGuid}-abc-ab12cd-shm`,
    `${macGuid}-${macPid}-ab12cd-db`,
  ];
  expect(
    await settleInheritedTmpdirNames(names, {
      platform: "darwin",
      ancestors: new Set([1, 2]),
      pidAlive: () => true,
      statFile: regular,
    }),
  ).toEqual({ leftovers: names, settled: [] });
});

// Usefulness: verifies that a non-regular macOS name stays reported (issue #1600).
test("keeps a macOS non-regular name", async () => {
  expect(
    await settleInheritedTmpdirNames([macShm, macWal], {
      platform: "darwin",
      ancestors: new Set([1, 2]),
      pidAlive: () => true,
      statFile: async () => ({ isFile: () => false }),
    }),
  ).toEqual({ leftovers: [macShm, macWal], settled: [] });
});

// Usefulness: verifies that a macOS name for this process stays reported (issue #1600).
test("keeps a macOS name for this process", async () => {
  const name = `${macGuid}-${process.pid}-ab12cd-shm`;
  const sibling = `${macGuid}-${process.pid}-ab12cd-wal`;
  expect(
    await settleInheritedTmpdirNames([name, sibling], {
      platform: "darwin",
      ancestors: new Set(),
      pidAlive: () => true,
      statFile: regular,
    }),
  ).toEqual({ leftovers: [name, sibling], settled: [] });
});

// Usefulness: verifies that a macOS name for an ancestor stays reported (issue #1600).
test("keeps a macOS name for an ancestor", async () => {
  expect(
    await settleInheritedTmpdirNames([macShm, macWal], {
      platform: "darwin",
      ancestors: new Set([macPid]),
      pidAlive: () => true,
      statFile: regular,
    }),
  ).toEqual({ leftovers: [macShm, macWal], settled: [] });
});

// Usefulness: verifies that a macOS stat error keeps the name (issue #1600).
test("keeps a macOS name whose stat fails", async () => {
  expect(
    await settleInheritedTmpdirNames([macShm, macWal], {
      platform: "darwin",
      ancestors: new Set([1, 2]),
      pidAlive: () => true,
      statFile: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
  ).toEqual({ leftovers: [macShm, macWal], settled: [] });
});

// Usefulness: verifies that an unreadable ancestry settles no macOS name (issue #1600).
test("settles no macOS name without an ancestry", async () => {
  expect(
    await settleInheritedTmpdirNames([macShm, macWal], {
      platform: "darwin",
      ancestors: null,
      pidAlive: () => true,
      statFile: regular,
    }),
  ).toEqual({ leftovers: [macShm, macWal], settled: [] });
});

// Usefulness: verifies that a failed headless read keeps every name (issue #1600).
test("keeps every name when the headless read fails", async () => {
  const names = ["a.tmp", "b.tmp"];
  expect(
    await presentInheritedTmpdirReport(names, {
      read: async () => {
        throw new Error("EACCES");
      },
      platform: "win32",
      probe: async () => "held",
    }),
  ).toEqual({ present: names, settled: [] });
});

// Usefulness: verifies that a bounded headless read keeps every name (issue #1600).
test("keeps every name when the headless read passes its bound", async () => {
  const names = ["a.tmp"];
  expect(
    await presentInheritedTmpdirReport(names, {
      read: () => new Promise(() => {}),
      boundMs: 10,
      platform: "win32",
      probe: async () => "held",
    }),
  ).toEqual({ present: names, settled: [] });
});

// Usefulness: verifies that a canceled probe returns the cancel identity (issue #1600).
test("a cancel during a probe ends with the cancel identity", async () => {
  const controller = new AbortController();
  const name = "a.tmp";
  const pending = presentInheritedTmpdir([name], {
    read: async () => [name],
    platform: "win32",
    probe: () => new Promise(() => {}),
    signal: controller.signal,
    settle: {
      boundMs: 60_000,
      intervalMs: 60_000,
      signal: controller.signal,
    },
  });
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies that a canceled headless probe returns the cancel identity (issue #1600).
test("a cancel during a headless probe ends with the cancel identity", async () => {
  const controller = new AbortController();
  const name = "a.tmp";
  const pending = presentInheritedTmpdirReport([name], {
    read: async () => [name],
    platform: "win32",
    probe: () => new Promise(() => {}),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies that a held real Windows file is settled (issue #1600).
test.skipIf(process.platform !== "win32")(
  "probes a held Windows file read-only and closes its handle",
  async () => {
    const name = "e8c59ef2-eccc-4f6d-9bc3-81f2f0ef163b.tmp";
    const path = join(root, name);
    await writeFile(path, "keep");
    const holder = await openFile(path, "r");
    try {
      expect(await settleInheritedTmpdirNames([name], { platform: "win32" })).toEqual({
        leftovers: [],
        settled: [name],
      });
    } finally {
      await holder.close();
    }
    expect(await readFile(path, "utf8")).toBe("keep");
    expect(await settleInheritedTmpdirNames([name], { platform: "win32" })).toEqual({
      leftovers: [name],
      settled: [],
    });
    // A leaked exclusive-share handle makes this removal fail.
    await rm(path);
  },
);

// Usefulness: verifies that the Windows probe settles no directory (issue #1600).
test.skipIf(process.platform !== "win32")("keeps a Windows directory", async () => {
  const name = "a-directory";
  await mkdir(join(root, name));
  expect(await settleInheritedTmpdirNames([name], { platform: "win32" })).toEqual({
    leftovers: [name],
    settled: [],
  });
});

// Usefulness: verifies that a failed ancestry read settles no macOS name (issue #1600).
test("settles no macOS name when the ancestry read fails", async () => {
  expect(
    await presentInheritedTmpdirReport([macShm, macWal], {
      read: async () => [macShm, macWal],
      platform: "darwin",
      readAncestors: async () => {
        throw new Error("EACCES");
      },
      pidAlive: () => true,
      statFile: regular,
    }),
  ).toEqual({ present: [macShm, macWal], settled: [] });
});

// Usefulness: verifies that a canceled ancestry read returns the cancel identity (issue #1600).
test("a cancel during the ancestry read ends with the cancel identity", async () => {
  await expect(
    presentInheritedTmpdirReport([macShm, macWal], {
      read: async () => [macShm, macWal],
      platform: "darwin",
      readAncestors: async () => {
        throw Object.assign(new Error("Interrupted"), { isCanceled: true });
      },
      pidAlive: () => true,
      statFile: regular,
    }),
  ).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies that only an open EBUSY settles a name (issue #1600).
test("keeps a Windows name when lstat reports EBUSY", async () => {
  expect(
    await probeHeldOpenWindows("a.tmp", {
      lstatFile: async () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
      openHandle: async () => {
        throw new Error("must not open");
      },
    }),
  ).toBe("unknown");
});

// Usefulness: verifies that an fstat EBUSY keeps the name (issue #1600).
test("keeps a Windows name when fstat reports EBUSY", async () => {
  let closed = false;
  expect(
    await probeHeldOpenWindows("a.tmp", {
      lstatFile: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
      openHandle: async () => ({
        stat: async () => {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
        close: async () => {
          closed = true;
        },
      }),
    }),
  ).toBe("unknown");
  expect(closed).toBe(true);
});

// Usefulness: verifies that a device mismatch keeps the name (issue #1600).
test("keeps a Windows file whose device differs", async () => {
  expect(
    await probeHeldOpenWindows("a.tmp", {
      lstatFile: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
      openHandle: async () => ({
        stat: async () => ({ dev: 2n, ino: 2n }),
        close: async () => {},
      }),
    }),
  ).toBe("unknown");
});

// Usefulness: verifies that a replacement link keeps the name (issue #1600).
test("keeps a Windows file replaced by a link between lstat and open", async () => {
  let closed = false;
  expect(
    await probeHeldOpenWindows("a.tmp", {
      lstatFile: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
      openHandle: async () => ({
        stat: async () => ({ dev: 3n, ino: 4n }),
        close: async () => {
          closed = true;
        },
      }),
    }),
  ).toBe("unknown");
  expect(closed).toBe(true);
});

// Usefulness: verifies that the ancestor set includes PID 1 (issue #1600).
test("collects every ancestor up to PID 1", async () => {
  const table = [
    { pid: process.pid, ppid: 4242 },
    { pid: 4242, ppid: 1 },
    { pid: 1, ppid: 0 },
  ];
  expect(await readAncestorPids({ readTable: async () => table })).toEqual(
    new Set([process.pid, 4242, 1]),
  );
});

// Usefulness: verifies that an ancestry without this process returns null (issue #1600).
test("returns null when the ancestry omits this process", async () => {
  expect(await readAncestorPids({ readTable: async () => [{ pid: 1, ppid: 0 }] })).toBeNull();
});

// Usefulness: verifies that an ancestry cycle returns null (issue #1600).
test("returns null on an ancestry cycle", async () => {
  const table = [
    { pid: process.pid, ppid: 4242 },
    { pid: 4242, ppid: process.pid },
  ];
  expect(await readAncestorPids({ readTable: async () => table })).toBeNull();
});

// Usefulness: verifies that a failed ancestry read returns null (issue #1600).
test("returns null when the ancestry read fails", async () => {
  expect(
    await readAncestorPids({
      readTable: async () => {
        throw new Error("EACCES");
      },
    }),
  ).toBeNull();
});

// Usefulness: verifies that a canceled ancestry read rejects canceled (issue #1600).
test("a canceled ancestry read rejects canceled", async () => {
  await expect(
    readAncestorPids({
      readTable: async () => {
        throw Object.assign(new Error("Interrupted"), { isCanceled: true });
      },
    }),
  ).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies that a macOS name for PID 1 stays reported (issue #1600).
test("keeps a macOS name for PID 1", async () => {
  const name = `${macGuid}-1-ab12cd-shm`;
  const sibling = `${macGuid}-1-ab12cd-wal`;
  expect(
    await settleInheritedTmpdirNames([name, sibling], {
      platform: "darwin",
      ancestors: new Set([1]),
      pidAlive: () => true,
      statFile: regular,
    }),
  ).toEqual({ leftovers: [name, sibling], settled: [] });
});

// Usefulness: verifies that settle.signal cancels the ancestry read at once (issue #1600).
test("a cancel through settle.signal aborts the ancestry read at once", async () => {
  const controller = new AbortController();
  let release;
  const started = new Promise((resolve) => {
    release = resolve;
  });
  const pending = presentInheritedTmpdir([macShm, macWal], {
    read: async () => [macShm, macWal],
    platform: "darwin",
    readAncestors: () => {
      release();
      return new Promise(() => {});
    },
    pidAlive: () => true,
    statFile: regular,
    probeBoundMs: 60_000,
    settle: {
      boundMs: 60_000,
      intervalMs: 60_000,
      signal: controller.signal,
    },
  });
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies that a non-regular entry never reaches the open (issue #1600).
test("keeps a non-regular Windows entry before the open", async () => {
  for (const info of [{ isFile: () => false }, { isFile: () => false, isFIFO: () => true }]) {
    let opened = false;
    expect(
      await probeHeldOpenWindows("entry", {
        lstatFile: async () => info,
        openHandle: async () => {
          opened = true;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      }),
    ).toBe("unknown");
    expect(opened).toBe(false);
  }
});
