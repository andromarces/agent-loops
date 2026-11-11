import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import {
  shimCallRecords,
  shimCallSteps,
  shimStartPids,
  withGitHangingAfter,
} from "./process-helpers.mjs";
import { pollUntil } from "./wait-helpers.mjs";

// Usefulness: verifies each shim call leaves a record with its claimed number and pid, so a
// failed run can say how many calls never reached the shim (issue #1258); no other test reads it.
test.concurrent.skipIf(process.platform === "win32")(
  "withGitHangingAfter records the claimed number and pid of each call",
  async () => {
    await withGitHangingAfter(2, async ({ shimDir, env }) => {
      for (let call = 0; call < 2; call += 1) {
        await execa("git", ["--version"], { env });
      }
      const found = await shimCallRecords(shimDir);
      expect(found.map((record) => record.number).sort((a, b) => a - b)).toEqual([0, 1]);
      expect(found.every((record) => Number.isInteger(record.pid) && record.pid > 0)).toBe(true);
    });
  },
  30_000,
);

// Usefulness: verifies the shim writes a marker named by the pid of the call. The failure message
// of the 60-call test (issue #1258) reads the markers, and the record test does not cover them.
test.concurrent.skipIf(process.platform === "win32")(
  "withGitHangingAfter marks the start of each shim call with the pid of the call",
  async () => {
    await withGitHangingAfter(1, async ({ shimDir, env }) => {
      const call = execa("git", ["--version"], { env });
      const { pid } = call;
      await call;
      expect(await shimStartPids(shimDir)).toEqual([pid]);
    });
  },
  30_000,
);

// Usefulness: verifies a marker that cannot be written leaves the claim unchanged (issue #1258).
// A diagnostic must not alter the path of a call, and the marker test above writes it.
test.concurrent.skipIf(process.platform === "win32")(
  "withGitHangingAfter still claims a number when the start marker cannot be written",
  async () => {
    await withGitHangingAfter(1, async ({ shimDir, env }) => {
      await rm(join(shimDir, "started"), { recursive: true });
      await writeFile(join(shimDir, "started"), "");
      const call = await execa("git", ["--version"], { reject: false, timeout: 5000, env });
      expect(call.exitCode).toBe(0);
      expect((await shimCallRecords(shimDir)).map((record) => record.number)).toEqual([0]);
    });
  },
  30_000,
);

// Usefulness: verifies each call writes its start and claim steps, so a failure can name the last
// step a call recorded (issue #1258). The record test reads the claim only, and no other test
// reads the steps.
test.concurrent.skipIf(process.platform === "win32")(
  "withGitHangingAfter records the start and the claim of each call",
  async () => {
    await withGitHangingAfter(2, async ({ shimDir, env }) => {
      const calls = [execa("git", ["--version"], { env }), execa("git", ["--version"], { env })];
      const pids = calls.map((call) => call.pid);
      await Promise.all(calls);
      const steps = await shimCallSteps(shimDir);
      expect([...steps.keys()].sort((a, b) => a - b)).toEqual([...pids].sort((a, b) => a - b));
      for (const pid of pids) {
        expect(steps.get(pid)).toHaveLength(2);
        expect(steps.get(pid)[0]).toMatch(/^start \d+$/);
        expect(steps.get(pid)[1]).toMatch(/^claimed \d+$/);
      }
    });
  },
  30_000,
);

// Usefulness: verifies a call counts a number only when its own directory and record exist. The
// test injects one `mkdir` that reports success without the directory. An exit-0 call without its
// record fails here (issue #1258).
test.concurrent.skipIf(process.platform === "win32")(
  "withGitHangingAfter claims a number only when its call directory holds its record",
  async () => {
    await withGitHangingAfter(1, async ({ shimDir, env }) => {
      // The shim resolves `mkdir` through `shimDir` first. The first call to create call-0 is told
      // that it succeeded without a directory, and every later call gets the real `mkdir`. The
      // noclobber create makes exactly one call take the lie, also when calls start at once.
      const realMkdir = existsSync("/bin/mkdir") ? "/bin/mkdir" : "/usr/bin/mkdir";
      await writeFile(
        join(shimDir, "mkdir"),
        [
          "#!/bin/sh",
          `if [ "$1" = '${shimDir}/call-0' ] && (set -C; : > '${shimDir}/lied') 2>/dev/null; then`,
          "  exit 0",
          "fi",
          `exec '${realMkdir}' "$@"`,
        ].join("\n"),
        { mode: 0o755 },
      );
      const running = [
        execa("git", ["--version"], { reject: false, env }),
        execa("git", ["--version"], { reject: false, env }),
      ];
      const records = await pollUntil(async () => {
        const found = await shimCallRecords(shimDir);
        return found.length === 2 ? found : undefined;
      }, 10_000);
      const passing = await Promise.race(running.map((call, index) => call.then(() => index)));
      const hung = running[1 - passing];
      // The case waits out this 200 ms deadline because the deadline ending the hang is what it tests.
      const deadline = setTimeout(() => hung.kill("SIGKILL"), 200);
      const calls = await Promise.all(running);
      clearTimeout(deadline);
      expect(calls.filter((call) => call.exitCode === 0)).toHaveLength(1);
      expect(records.map((record) => record.number).sort((a, b) => a - b)).toEqual([0, 1]);
    });
  },
  30_000,
);

// Usefulness: verifies the shim of withGitHangingAfter lets exactly `passes` calls through when
// calls start at once, as the concurrent reads of one snapshot do. A call counter that is not
// atomic loses updates and can read a half-written count, so a snapshot read that must pass hangs,
// or one that must hang passes (the CI failure of "a second cancel ends a hung evidence snapshot").
test.concurrent.skipIf(process.platform === "win32")(
  "withGitHangingAfter passes exactly the requested number of concurrent calls",
  async () => {
    const passes = 10;
    await withGitHangingAfter(passes, async ({ shimDir, env }) => {
      // GIT_TRACE2_EVENT makes a real `git` write `trace-<index>`, with or without the shim.
      const running = Array.from({ length: 2 * passes }, (_, index) =>
        execa("git", ["--version"], {
          reject: false,
          env: { ...env, GIT_TRACE2_EVENT: join(shimDir, `trace-${index}`) },
        }),
      );
      const pids = running.map((call) => call.pid);
      const settled = new Set();
      running.forEach((call, index) => {
        call.then(() => settled.add(index));
      });
      await pollUntil(async () => {
        const found = await shimCallRecords(shimDir);
        return found.length === 2 * passes ? found : undefined;
      }, 20_000);
      await pollUntil(() => (settled.size >= passes ? true : undefined), 20_000);
      // The case waits out this 200 ms deadline because the deadline ending the hang is what it tests.
      const deadline = setTimeout(() => {
        running.forEach((call, index) => {
          if (!settled.has(index)) call.kill("SIGKILL");
        });
      }, 200);
      const calls = await Promise.all(running);
      clearTimeout(deadline);
      // The message names the call-* counts, the marker and step counts, and each exit code. It also
      // names the steps of each call without a record, so a CI recurrence records them. The reads
      // never throw, so the assertion below always runs. A timed-out call shows as "timeout".
      const names = await readdir(shimDir).catch(() => undefined);
      const claimed = names?.filter((name) => name.startsWith("call-")).length;
      const records = await shimCallRecords(shimDir).catch(() => undefined);
      const markers = await shimStartPids(shimDir).catch(() => undefined);
      const steps = await shimCallSteps(shimDir).catch(() => undefined);
      const codes = calls.map((call) => call.exitCode ?? (call.timedOut ? "timeout" : "undefined"));
      const loggedClaims =
        steps === undefined
          ? "unreadable"
          : [...steps.values()].filter((lines) => lines.some((line) => line.startsWith("claimed ")))
              .length;
      // Each call without a record shows as index:pid:exit code:marker state:trace state:steps. Each
      // state is what the read found: present, absent, or unreadable. An absent file is an
      // observation only.
      const state = (found) => (found === undefined ? "unreadable" : found ? "present" : "absent");
      const unrecorded = calls
        .map((_, index) => index)
        .filter((index) => !records?.some((record) => record.pid === pids[index]))
        .map((index) => {
          const marker = state(markers?.includes(pids[index]));
          const trace = state(names?.includes(`trace-${index}`));
          const reached =
            steps === undefined ? "unreadable" : (steps.get(pids[index]) ?? ["absent"]).join("|");
          return `${index}:${pids[index]}:exit ${codes[index]}:marker ${marker}:trace ${trace}:steps ${reached}`;
        });
      const message = records
        ? `call-* directories: ${claimed}; call-* directories without a record: ${claimed - records.length}; start markers: ${markers?.length}; step records: ${steps?.size}; claims logged: ${loggedClaims}; calls without a shim record: ${unrecorded.length} [${unrecorded.join(" ")}]; exit codes: ${codes.join(",")}`
        : `the shim records or directory were unreadable; exit codes: ${codes.join(",")}`;
      expect(
        calls.filter((call) => call.exitCode === 0),
        message,
      ).toHaveLength(passes);
    });
  },
  30_000,
);
