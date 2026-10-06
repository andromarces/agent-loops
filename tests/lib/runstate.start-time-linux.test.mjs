import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { processStartTime, withStateLock } from "../../src/lib/runstate.mjs";
import { deadPid, removePath } from "../runtime-helpers.mjs";

// The Linux source reads /proc, which does not exist on the other test platforms, so
// the platform is fixed to linux and `readFile` answers the /proc paths from a table.
// `execFile` throws: the Linux source must never spawn a process.
const realFs = await vi.importActual("node:fs/promises");
const realPlatform = process.platform;
const BOOT_ID = "0b6f3b86-6f1c-4c2e-9d57-3c1f0a5d2e10";
const NAMESPACE = "4026531836";
let proc = {};
let namespaceLink = `pid:[${NAMESPACE}]`;

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  readFile: vi.fn(async (file, ...rest) =>
    String(file).startsWith("/proc/") ? procFile(String(file)) : realFs.readFile(file, ...rest),
  ),
  readlink: vi.fn(async (file, ...rest) => {
    if (file !== "/proc/self/ns/pid") {
      return await realFs.readlink(file, ...rest);
    }
    if (namespaceLink === null) {
      throw Object.assign(new Error("ENOENT /proc/self/ns/pid"), { code: "ENOENT" });
    }
    return namespaceLink;
  }),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => {
    throw new Error("the Linux source must not spawn");
  }),
}));

function procFile(file) {
  if (!(file in proc)) {
    throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
  }
  return proc[file];
}

// Fields 3 to 22 of /proc/<pid>/stat after the command name, with `ticks` as field 22.
function statLine(ticks, comm = "node (a b)") {
  return `${process.pid} (${comm}) S 1 1 1 0 -1 4194560 1 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 1000 1`;
}

// /proc/self/status as the kernel prints it (tab after the key), with `nspid` as the
// value of the NSpid line, or without that line when `nspid` is null.
function statusFile(nspid = String(process.pid)) {
  return `Name:\tnode\nUmask:\t0022\nTgid:\t${process.pid}\n${
    nspid === null ? "" : `NSpid:\t${nspid}\n`
  }NSpgid:\t1\n`;
}

function setProc(ticks, bootId = BOOT_ID) {
  namespaceLink = `pid:[${NAMESPACE}]`;
  proc = {
    "/proc/self/status": statusFile(),
    [`/proc/${process.pid}/stat`]: statLine(ticks),
    "/proc/sys/kernel/random/boot_id": `${bootId}\n`,
  };
}

beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
});

let dirs = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

async function lockWith(startTime, pid = process.pid) {
  const dir = await mkdtemp(join(tmpdir(), "runstate-linux-"));
  dirs.push(dir);
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, JSON.stringify({ pid, startedAt: "old", startTime }));
  return lockFile;
}

// Usefulness: verifies the stamp is the namespace, the boot id and the ticks of field 22, read past a
// command name that holds spaces and parentheses.
test("processStartTime reads the ticks, the boot id, and the PID namespace from /proc", async () => {
  setProc(987_654);

  await expect(processStartTime(process.pid)).resolves.toBe(
    `linux-proc:${NAMESPACE}:${BOOT_ID}:987654`,
  );
});

// Usefulness: verifies a wall-clock step of 10 s (NTP, a manual set, a suspend) does
// not free the lock of a running owner, the reviewer's failure of the ps-based stamp.
test("a live lock is kept after the wall clock steps 10 seconds", async () => {
  setProc(987_654);
  const lockFile = await lockWith(`linux-proc:${NAMESPACE}:${BOOT_ID}:987654`);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 10_000);

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies a pid reused by a process of the same boot (other ticks), or
// after a reboot (other boot id), reads as a different process and the lock is taken over.
test.each([
  ["other ticks", `linux-proc:${NAMESPACE}:${BOOT_ID}:111`],
  ["another boot", `linux-proc:${NAMESPACE}:11111111-2222-3333-4444-555555555555:987654`],
])("a lock with %s is taken over", async (_name, recorded) => {
  setProc(987_654);
  const lockFile = await lockWith(recorded);

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
});

// Usefulness: verifies every unreadable or incomparable stamp reads as alive: no
// /proc entry, a malformed stat, a kind of another platform, and an earlier number.
test.each([
  ["a missing /proc entry", {}, `linux-proc:${NAMESPACE}:${BOOT_ID}:111`],
  [
    "a malformed stat",
    {
      "/proc/self/status": statusFile(),
      [`/proc/${process.pid}/stat`]: "garbage",
      "/proc/sys/kernel/random/boot_id": BOOT_ID,
    },
    `linux-proc:${NAMESPACE}:${BOOT_ID}:111`,
  ],
  ["a kind mismatch", null, "darwin-lstart:100"],
  ["an earlier number format", null, 100],
])("a live lock is kept for %s", async (_name, table, recorded) => {
  if (table === null) {
    setProc(987_654);
  } else {
    proc = table;
  }
  const lockFile = await lockWith(recorded);

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies a lock written in another PID namespace (a container that shares
// the runs root) is never taken over on a stamp mismatch: its pid means another process
// here, so a live foreign owner must not read as dead.
test.each([
  ["other ticks", `linux-proc:4026532999:${BOOT_ID}:111`],
  ["another boot", "linux-proc:4026532999:11111111-2222-3333-4444-555555555555:111"],
])("a live lock of another PID namespace with %s is kept", async (_name, recorded) => {
  setProc(987_654);
  const lockFile = await lockWith(recorded);

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies an unreadable PID namespace of the reader gives no stamp, so the
// stamp comparison is skipped and a live lock is kept.
test("a live lock is kept when the PID namespace of the reader cannot be read", async () => {
  setProc(987_654);
  namespaceLink = null;
  const lockFile = await lockWith(`linux-proc:${NAMESPACE}:${BOOT_ID}:111`);

  await expect(processStartTime(process.pid)).resolves.toBeNull();
  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies a recorded linux-proc stamp that is structurally wrong never
// frees a lock, whichever field is malformed.
test.each([
  "linux-proc:garbage",
  "linux-proc:",
  `linux-proc:${BOOT_ID}:111`,
  `linux-proc:${NAMESPACE}:not-a-boot-id:111`,
  `linux-proc:${NAMESPACE}:${BOOT_ID}:abc`,
  `linux-proc:${NAMESPACE}:${BOOT_ID}:-1`,
  `linux-proc:${NAMESPACE}:${BOOT_ID}:1.5`,
  `linux-proc:${NAMESPACE}:${BOOT_ID}:1e3`,
  `linux-proc:${NAMESPACE}:${BOOT_ID}:111:extra`,
  `linux-proc:${NAMESPACE}:${BOOT_ID}:`,
])("a live lock is kept for the malformed stamp %j", async (recorded) => {
  setProc(987_654);
  const lockFile = await lockWith(recorded);

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies a /proc view that is not the caller's PID namespace gives no
// stamp, so the stat of an unrelated process is never taken for the owner and a live lock
// is kept. The self link equals process.pid in every case, so only the NSpid check
// (proc_pid_status(5): the leftmost entry is the pid in the namespace of the procfs mount,
// followed by each nested inner namespace) can refuse the two-entry ancestor view.
test.each([
  ["an ancestor view (two NSpid entries)", `${process.pid}\t77`],
  ["an ancestor view of three namespaces", `${process.pid}\t77\t1`],
  ["a single entry of another pid", "4242"],
  ["a missing NSpid line", null],
  ["an empty NSpid line", ""],
  ["a malformed NSpid line", "abc"],
  ["a signed NSpid entry", `+${process.pid}`],
  ["a padded NSpid entry", `0${process.pid}`],
])("a live lock is kept when /proc/self/status has %s", async (_name, nspid) => {
  setProc(987_654);
  proc["/proc/self/status"] = statusFile(nspid);
  const lockFile = await lockWith(`linux-proc:${NAMESPACE}:${BOOT_ID}:111`);

  await expect(processStartTime(process.pid)).resolves.toBeNull();
  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies an unreadable /proc/self/status gives no stamp, so the owner reads
// as alive.
test("a live lock is kept when /proc/self/status cannot be read", async () => {
  setProc(987_654);
  delete proc["/proc/self/status"];
  const lockFile = await lockWith(`linux-proc:${NAMESPACE}:${BOOT_ID}:111`);

  await expect(processStartTime(process.pid)).resolves.toBeNull();
  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies a lock whose stamp names another PID namespace is kept when its pid does
// not exist in the reader namespace (a container pid), so a running foreign owner is not taken over.
test("a lock of another PID namespace with a pid absent here is kept", async () => {
  setProc(987_654);
  const lockFile = await lockWith(`linux-proc:4026532999:${BOOT_ID}:111`, await deadPid());

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies a lock with a linux-proc stamp is kept when the reader namespace cannot be
// read, because no namespace comparison is possible and a pid probe alone cannot clear the owner.
test("a linux-proc lock with a pid absent here is kept when the reader namespace cannot be read", async () => {
  setProc(987_654);
  namespaceLink = null;
  const lockFile = await lockWith(`linux-proc:${NAMESPACE}:${BOOT_ID}:111`, await deadPid());

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
});

// Usefulness: verifies a dead owner of the reader namespace is still taken over, so the namespace
// guard does not keep every stamped lock.
test("a lock of the same PID namespace with a dead pid is taken over", async () => {
  setProc(987_654);
  const lockFile = await lockWith(`linux-proc:${NAMESPACE}:${BOOT_ID}:111`, await deadPid());

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
});

// Usefulness: verifies a lock without a stamp keeps the pid-only check, so a dead pid is taken over.
test("a lock without a stamp and with a dead pid is taken over", async () => {
  setProc(987_654);
  const lockFile = await lockWith(undefined, await deadPid());

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
});
