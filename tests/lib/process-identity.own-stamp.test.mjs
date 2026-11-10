import { expect, test, vi } from "vite-plus/test";

// Counts the `ps` queries that the module starts, and answers them with the real command.
const queries = vi.hoisted(() => ({ ps: 0 }));
vi.mock("../../src/lib/exec.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execBounded: async (command, args, options) => {
      if (command === "ps") queries.ps += 1;
      return real.execBounded(command, args, options);
    },
  };
});

const { ownStartTime, ownerAlive } = await import("../../src/lib/process-identity.mjs");

// Usefulness: verifies repeated lock checks of this process reuse the memoized own stamp, so only one `ps` starts per process.
test.skipIf(process.platform !== "darwin")(
  "a lock of this process starts no start-time query per check",
  async () => {
    const stamp = await ownStartTime();
    expect(stamp).toEqual(expect.any(String));
    const before = queries.ps;
    for (let check = 0; check < 3; check++) {
      await expect(ownerAlive({ pid: process.pid, startTime: stamp })).resolves.toBe(true);
    }
    expect(queries.ps).toBe(before);
  },
);
