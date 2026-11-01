import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo } from "./git-helpers.mjs";

// The order in which the post-turn `git` reads start and end. `slowStatus` delays the end of the
// work tree status read, as a large work tree does.
const reads = vi.hoisted(() => ({ events: [], slowStatus: false }));
vi.mock("../src/lib/exec.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execBounded: async (command, args, ...rest) => {
      if (command !== "git") return real.execBounded(command, args, ...rest);
      if (args.includes("--git-common-dir")) reads.events.push("shared read started");
      const result = await real.execBounded(command, args, ...rest);
      if (args[0] === "status" && reads.slowStatus) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        reads.events.push("work tree status ended");
      }
      return result;
    },
  };
});

let repo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  reads.slowStatus = false;
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
          reads.slowStatus = true;
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
