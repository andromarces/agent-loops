import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { removeAbandonedTurnTmpdir, withTurnTmpdir } from "../../src/lib/turn-tmpdir.mjs";
import { processStartTime } from "../../src/lib/process-identity.mjs";
import { deadPid, removePath } from "../runtime-helpers.mjs";

const TMP_VARS = ["TMPDIR", "TEMP", "TMP", "AGENT_LOOP_RUNS_ROOT"];

// Runs `body(root, base)` with the inherited temporary directory set to a fresh `root`, and the
// runs root beside it, so the registry of turn directories adds no entry to `root`.
async function withRoot(body) {
  const base = await mkdtemp(join(tmpdir(), "turn-tmpdir-"));
  const saved = TMP_VARS.map((name) => process.env[name]);
  const root = join(base, "root");
  mkdirSync(root);
  for (const name of TMP_VARS) process.env[name] = root;
  process.env.AGENT_LOOP_RUNS_ROOT = join(base, "runs");
  try {
    return await body(root, base);
  } finally {
    TMP_VARS.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
    await removePath(base);
  }
}

// Usefulness: verifies a directory that replaces the turn directory before the removal starts keeps
// its content, because the removal acts only on the directory that the runtime created.
test("a replacement of the turn directory loses no content", async () => {
  await withRoot(async (root, base) => {
    let sentinel;
    await withTurnTmpdir(async (env) => {
      renameSync(env.TMPDIR, join(base, "moved"));
      mkdirSync(env.TMPDIR);
      sentinel = join(env.TMPDIR, "sentinel.txt");
      writeFileSync(sentinel, "keep\n");
    });
    expect(existsSync(sentinel)).toBe(true);
    expect(readdirSync(root)).toHaveLength(1);
  });
});

// Usefulness: verifies a directory that replaces the turn directory while the removal runs is not
// removed by the final `rmdir`, so the removal never deletes a directory it did not create.
// Windows refuses to rename a directory that another process holds as its working directory, which
// the helper does while it deletes. The swap then fails, the removal finishes, and nothing of
// another directory is at risk. The test accepts that outcome only when the rename was refused.
test("a replacement during the removal keeps its empty directory", async () => {
  await withRoot(async (root) => {
    // Windows cannot swap, so a short tree keeps its slow file creation within the test timeout.
    const TOP = process.platform === "win32" ? 20 : 400;
    let replacement;
    let swap = "never tried";
    await withTurnTmpdir(async (env) => {
      for (let d = 0; d < TOP; d++) {
        mkdirSync(join(env.TMPDIR, `d${d}`));
        for (let f = 0; f < 25; f++) writeFileSync(join(env.TMPDIR, `d${d}`, `f${f}`), "x");
      }
      replacement = env.TMPDIR;
      // Swaps as soon as the removal has started deleting content.
      const poll = setInterval(() => {
        try {
          if (readdirSync(replacement).length >= TOP) return;
        } catch {
          // The directory is mid-removal or gone: the next tick or the end of the test decides.
          return;
        }
        clearInterval(poll);
        try {
          renameSync(replacement, join(root, "moved"));
          mkdirSync(replacement);
          swap = "swapped";
        } catch (err) {
          swap = `refused ${err.code}`;
        }
      }, 1);
      setTimeout(() => clearInterval(poll), 20_000).unref();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (process.platform === "win32") {
      // The rename can be refused, and a tree this short can be gone before the first poll.
      expect(swap === "swapped" || swap.startsWith("refused") || swap === "never tried").toBe(true);
    } else {
      expect(swap).toBe("swapped");
    }
    if (swap === "swapped") {
      expect(existsSync(replacement)).toBe(true);
      expect(readdirSync(root).sort()).toEqual(["moved", basename(replacement)].sort());
    } else {
      // No swap happened on this run, so the removal finished normally.
      expect(existsSync(replacement)).toBe(false);
    }
  });
}, 60_000);

// Usefulness: verifies a recorded directory whose name is not a turn directory name is never
// removed, so an edited state file cannot steer the removal at another directory.
test("an abandoned-directory record with another name removes nothing", async () => {
  await withRoot(async (root) => {
    const other = join(root, "keep-me");
    mkdirSync(other);
    writeFileSync(join(other, "sentinel.txt"), "keep\n");
    await removeAbandonedTurnTmpdir({ dir: other, parentReal: root, device: "1", inode: "1" });
    expect(existsSync(join(other, "sentinel.txt"))).toBe(true);
  });
});

// The record that `onCreated` would hand over for a directory that a test made, with the identity
// of that directory and the given recorded child.
function abandonedRecord(root, child) {
  const dir = join(root, "al-abc123");
  mkdirSync(dir);
  writeFileSync(join(dir, "sentinel.txt"), "keep\n");
  const stat = lstatSync(dir, { bigint: true });
  return {
    dir,
    parentReal: dirname(realpathSync.native(dir)),
    device: String(stat.dev),
    inode: String(stat.ino),
    ...(child && { child }),
  };
}

// Usefulness: verifies issue #1207 review blocker 1, that a record the caller could not persist
// stops the turn before the child starts and leaves no turn directory behind.
test("a failed record of the turn directory stops the turn and removes the directory", async () => {
  await withRoot(async (root) => {
    let started = false;
    await expect(
      withTurnTmpdir(
        async () => {
          started = true;
        },
        {
          onCreated: async () => {
            throw new Error("state write failed");
          },
        },
      ),
    ).rejects.toThrow("state write failed");
    expect(started).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

// Usefulness: verifies issue #1216 record origin, that a record whose parent is not the inherited
// temporary directory of the call removes nothing, so an edited state file cannot steer the removal
// at an `al-` directory elsewhere with its real identity.
test("an abandoned-directory record outside the inherited temporary directory removes nothing", async () => {
  await withRoot(async (root, base) => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    const record = abandonedRecord(elsewhere, { pid: await deadPid() });
    await removeAbandonedTurnTmpdir(record);
    expect(existsSync(join(record.dir, "sentinel.txt"))).toBe(true);
  });
});

// Usefulness: verifies issue #1207 review blocker 2, that a recorded child that still runs keeps
// the directory, because the recovery would delete a directory that the live child still uses.
test("an abandoned directory whose recorded child still runs is kept", async () => {
  await withRoot(async (root) => {
    const record = abandonedRecord(root, {
      pid: process.pid,
      startTime: (await processStartTime(process.pid)) ?? undefined,
    });
    await removeAbandonedTurnTmpdir(record);
    expect(existsSync(join(record.dir, "sentinel.txt"))).toBe(true);
  });
});

// Usefulness: verifies issue #1207 review blocker 2, that a record with no child pid keeps the
// directory, because no process of the dead turn can be ruled out.
test("an abandoned directory with no recorded child is kept", async () => {
  await withRoot(async (root) => {
    const record = abandonedRecord(root);
    await removeAbandonedTurnTmpdir(record);
    expect(existsSync(join(record.dir, "sentinel.txt"))).toBe(true);
  });
});

// Usefulness: verifies that the liveness check does not keep a directory forever, so a recorded
// child that has ended lets the removal run.
test("an abandoned directory whose recorded child has ended is removed", async () => {
  await withRoot(async (root) => {
    const record = abandonedRecord(root, { pid: await deadPid() });
    await removeAbandonedTurnTmpdir(record);
    expect(existsSync(record.dir)).toBe(false);
  });
});

// Usefulness: verifies issue #1216 POSIX descendants, that a descendant which outlives a dead child
// keeps the directory. The child leads its own process group (execa `killDescendants`), and the
// group stays while any member runs, which the table no longer shows after the reparent. Not
// redundant with the dead-child test above, which has no descendant.
test.skipIf(process.platform === "win32")(
  "an abandoned directory whose dead child left a live descendant in its group is kept",
  async () => {
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
console.log(c.pid);
c.unref();`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let grandchild;
    try {
      let out = "";
      leader.stdout.on("data", (chunk) => (out += chunk));
      await new Promise((resolve) => leader.once("exit", resolve));
      grandchild = Number(out.trim());
      expect(grandchild).toBeGreaterThan(0);
      await withRoot(async (root) => {
        const record = abandonedRecord(root, { pid: leader.pid });
        await removeAbandonedTurnTmpdir(record);
        expect(existsSync(join(record.dir, "sentinel.txt"))).toBe(true);
      });
    } finally {
      if (grandchild > 0) process.kill(grandchild, "SIGKILL");
    }
  },
);
