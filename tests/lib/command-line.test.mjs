import { delimiter } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  heldSessionIds,
  refuseHeldIds,
  refuseHeldSessions,
  splitWindowsArguments,
} from "../../src/lib/command-line.mjs";
import { ProcessReadError } from "../../src/lib/process-ancestry.mjs";
import { createPsShim } from "../process-helpers.mjs";
import { within } from "../wait-helpers.mjs";

// Expected tokens come from the argument parser of the C runtime, which gives `process.argv` in Node:
// the column is `process.argv.slice(2)` of a child that node started with the raw command line
// `<node> child.mjs <line>`, run on Windows 11 Pro 10.0.26220 with Node v26.8.1 (#673). The native
// `claude.exe` 2.1.296 on this host reads a command line the same way: `claude.exe --output-format
// "b""c" d` reports the argument `b"c`, and `"b""" c` reports `b"`. `CommandLineToArgvW` (called through PowerShell 7.6.6 on the same host) differs for
// a doubled quote inside a quoted section (it leaves the section), so it is not used (ADR 0032).
// Each row is [command line, tokens].
const NATIVE_TOKENS = [
  ['a ""b"" c', ["a", "b", "c"]],
  ['a "" b', ["a", "", "b"]],
  ['a "b""c" d', ["a", 'b"c', "d"]],
  ['a "b ""c d"" e" f', ["a", 'b "c d" e', "f"]],
  ['a """b""" c', ["a", '"b"', "c"]],
  ['a "b""" c', ["a", 'b"', "c"]],
  ['a """" c', ["a", '"', "c"]],
  ['a """b c', ["a", '"b c']],
  ['a b""c d', ["a", "bc", "d"]],
  ['a "b c"" d', ["a", 'b c" d']],
  ['a \\"b c', ["a", '"b', "c"]],
  ['a \\\\"b c" d', ["a", "\\b c", "d"]],
  ['a \\\\\\"b c', ["a", '\\"b', "c"]],
  ['a "b\\\\" c', ["a", "b\\", "c"]],
  ['a "b\\\\\\" c" d', ["a", 'b\\" c', "d"]],
  ["a C:\\x\\ y", ["a", "C:\\x\\", "y"]],
  ['a "C:\\x y\\\\" z', ["a", "C:\\x y\\", "z"]],
  ['a "--resume" id', ["a", "--resume", "id"]],
  ['a "--session-id=id" b', ["a", "--session-id=id", "b"]],
  ['a --resume="id" b', ["a", "--resume=id", "b"]],
  ['a --resume ""id"" b', ["a", "--resume", "id", "b"]],
  ['a ""--resume"" id', ["a", "--resume", "id"]],
  ['a "b', ["a", "b"]],
  ["a\tb  c", ["a", "b", "c"]],
  ['a "" "" c', ["a", "", "", "c"]],
  ['a """""" c', ["a", '""', "c"]],
  ['a "b"""', ["a", 'b"']],
  ['a "b"c d', ["a", "bc", "d"]],
  ['a "b c"d" e" f', ["a", "b cd e", "f"]],
  ["a b\\c d\\ e", ["a", "b\\c", "d\\", "e"]],
  ['a \\\\\\\\"b c" d', ["a", "\\\\b c", "d"]],
  ['a "b""c""d" e', ["a", 'b"c"d', "e"]],
  ['a "b"" c" d', ["a", 'b" c', "d"]],
  ['a ""', ["a", ""]],
  ['a """', ["a", '"']],
  ['a "x ""', ["a", 'x "']],
  ["a \\", ["a", "\\"]],
  ['a "\\" b', ["a", '" b']],
  ['a "b\tc" d', ["a", "b\tc", "d"]],
  ['a ""b c', ["a", "b", "c"]],
  ['a b"" "c d"', ["a", "b", "c d"]],
];

// Usefulness: verifies the Windows tokenizer equals the C runtime parser on every probed command line, including doubled quotes and backslash runs, so a quoted holder is read as the process reads it.
test("splitWindowsArguments matches the C runtime parser on the probed command lines", () => {
  for (const [line, tokens] of NATIVE_TOKENS) {
    expect(splitWindowsArguments(line), line).toEqual(tokens);
  }
});

const ID = "11111111-2222-4333-8444-555555555555";

// Usefulness: verifies a Windows process holds the session only through a session flag with the id, as the adapter passes it, including a quoted flag and a doubled-quote form, and never for a substring of an argument (#673).
test("heldSessionIds on Windows counts a session flag followed by the id", () => {
  for (const command of [
    `claude -p --resume ${ID} --output-format json`,
    `claude -p --session-id ${ID} --model haiku`,
    `claude -p -r ${ID}`,
    `claude -p --session-id=${ID}`,
    `claude -p --resume=${ID}`,
    `claude -p -r=${ID}`,
    `claude -p "--resume" ${ID}`,
    `claude -p "--session-id=${ID}"`,
    `claude -p --resume="${ID}"`,
    `claude -p --resume "${ID}"`,
    `claude -p --resume ""${ID}""`,
    `claude -p ""--resume"" ${ID}`,
    `claude -p --resume ${ID.toUpperCase()}`,
    String.raw`"C:\Program Files\claude.exe" -p --resume "${ID}"`,
    String.raw`C:\nvm\node.exe C:\nvm\node_modules\@anthropic-ai\claude-code\cli.js -p --resume ${ID}`,
    // The flag decides, not the program.
    `any-wrapper.exe --session-id ${ID}`,
  ]) {
    expect(heldSessionIds(command, "win32").has(ID), command).toBe(true);
  }
  for (const command of [
    `claude -p --resume ${ID}-copy`,
    `claude -p --resume x${ID}`,
    `claude -p --session-id-file=${ID}`,
    `claude -p --session-id-file ${ID}`,
    `claude -p --model=${ID}`,
    `claude -p --model ${ID}`,
    `claude -p --resume --verbose ${ID}`,
    String.raw`claude -p --log "C:\logs\${ID}.log"`,
    String.raw`claude -p --resume\"${ID}\"`,
    // A doubled quote inside a quoted section is a literal quote for the C runtime parser, which
    // `claude.exe` uses, so the id is not a whole argument.
    `claude -p "a "" ${ID}"`,
    `claude -p --resume "x ""${ID}"" y"`,
  ]) {
    expect(heldSessionIds(command, "win32").has(ID), command).toBe(false);
  }
});

// Usefulness: verifies a bare id argument is not a holder, whatever the program, so an unrelated program that carries the id, or a data argument named claude, does not block a run. This narrows the earlier bare-id refusal of ADR 0031 by maintainer decision (#673).
test("heldSessionIds ignores a bare id argument and an unrelated program", () => {
  for (const [command, platform] of [
    [`claude ${ID}`, "win32"],
    [`claude -p ${ID}`, "linux"],
    [`node app.js ${ID}`, "win32"],
    [`node test ${ID}`, "linux"],
    [`tool.exe "a "" ${ID}"`, "win32"],
    [`tail -f /logs/${ID}.log`, "linux"],
    [`cat claude ${ID}`, "linux"],
    [`vim /notes/claude ${ID}`, "linux"],
    [`grep claude ${ID} notes.txt`, "win32"],
  ]) {
    expect(heldSessionIds(command, platform).has(ID), command).toBe(false);
  }
});

// Usefulness: verifies a POSIX holder is found from the space-joined text of ps, where a quote or an apostrophe inside an earlier argument, or a space in a script path, must not hide a later flag and id (#673).
test("heldSessionIds on POSIX counts a session flag followed by the id and splits on white space only", () => {
  for (const command of [
    `claude -p --resume ${ID} --output-format json`,
    `claude -p --session-id ${ID}`,
    `claude -p -r ${ID}`,
    `claude -p --session-id=${ID}`,
    `claude -p -r=${ID}`,
    `/Users/John Doe/.local/bin/claude -p --session-id ${ID}`,
    `node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p --resume ${ID}`,
    `node /Users/John Doe/lib/node_modules/@anthropic-ai/claude-code/cli.js -p --resume ${ID}`,
    `claude -p --append-system-prompt it's a "test --resume ${ID}`,
    `claude -p --append-system-prompt "don't --resume ${ID}`,
  ]) {
    expect(heldSessionIds(command, "linux").has(ID), command).toBe(true);
  }
  for (const command of [
    `claude -p --resume ${ID}-copy`,
    `claude -p --resume x${ID}`,
    `claude -p --session-id-file=${ID}`,
    `claude -p --resume"${ID}"`,
    `claude -p "--resume=${ID}"`,
    `claude -p --resume --verbose ${ID}`,
  ]) {
    expect(heldSessionIds(command, "linux").has(ID), command).toBe(false);
  }
});

function roles(overrides = {}) {
  return {
    orchestrator: { kind: "codex", model: null, effort: null, sessionId: null },
    worker: { kind: "claude", model: "opus", effort: "high", sessionId: null },
    reviewer: { kind: "agy", model: null, effort: null, sessionId: null },
    ...overrides,
  };
}

const HELD_ID = "11111111-2222-4333-8444-555555555555";
const heldRoles = () =>
  roles({ worker: { kind: "claude", model: null, effort: null, sessionId: HELD_ID } });

// Usefulness: verifies a continued run refuses a Claude session that a live process holds (#647), which no other test covers.
test("refuseHeldSessions refuses a claude session whose id a live process names", async () => {
  const readProcessCommands = async () => [
    { pid: 4242, command: `claude -p --resume ${HELD_ID} --output-format json` },
  ];
  await expect(refuseHeldSessions(heldRoles(), { readProcessCommands })).rejects.toThrow(
    new RegExp(`worker.*${HELD_ID}.*process 4242`),
  );
});

// Usefulness: verifies the check does not block a continuation when no live process holds the id or the holder is this process.
test("refuseHeldSessions passes when no other process names the session id", async () => {
  const readProcessCommands = async () => [
    { pid: 1, command: "claude -p --resume 99999999-2222-4333-8444-555555555555" },
    { pid: process.pid, command: `node test ${HELD_ID}` },
  ];
  await expect(refuseHeldSessions(heldRoles(), { readProcessCommands })).resolves.toBeUndefined();
});

// Usefulness: verifies an unreadable process table warns and lets the run continue instead of blocking every --continue-from.
test("refuseHeldSessions continues when the process table cannot be read", async () => {
  const readProcessCommands = async () => {
    throw new Error("ps failed");
  };
  await expect(refuseHeldSessions(heldRoles(), { readProcessCommands })).resolves.toBeUndefined();
});

// Usefulness: verifies a short non-UUID id is never matched against command lines, so it cannot refuse a run because of an unrelated process.
test("refuseHeldSessions ignores an id that is not a UUID", async () => {
  const readProcessCommands = async () => [{ pid: 1, command: "launchd s w-1" }];
  const short = roles({ worker: { kind: "claude", model: null, effort: null, sessionId: "s" } });
  await expect(refuseHeldSessions(short, { readProcessCommands })).resolves.toBeUndefined();
});

const SENTINEL = "SECRET-SENTINEL-4f9a1c";
let shim;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await shim?.cleanup();
  shim = undefined;
});

async function useShim(body) {
  shim = await createPsShim(body);
  vi.stubEnv("PATH", `${shim.dir}${delimiter}${process.env.PATH}`);
}

// Usefulness: verifies the fail-open warning tells the operator the reason class of a failed
// read, and that no text of a reader error reaches the warning, because a process table holds the
// command lines of every process on the host (#647).
test("refuseHeldSessions warns with the reason class only when the read fails", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  await refuseHeldSessions(heldRoles(), {
    readProcessCommands: async () => {
      throw new ProcessReadError("exited with code 3");
    },
  });
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("the process table read exited with code 3."),
  );
  warn.mockClear();
  await refuseHeldSessions(heldRoles(), {
    readProcessCommands: async () => {
      throw new Error(`ps output: ${SENTINEL}`);
    },
  });
  expect(warn.mock.calls.flat().join("\n")).toContain("the process table read failed.");
  expect(warn.mock.calls.flat().join("\n")).not.toContain(SENTINEL);
});

// Usefulness: verifies a cancel of the read is not swallowed by the fail-open path.
test("refuseHeldSessions rethrows a canceled read", async () => {
  const canceled = new ProcessReadError("was canceled", { isCanceled: true });
  await expect(
    refuseHeldSessions(heldRoles(), {
      readProcessCommands: async () => {
        throw canceled;
      },
    }),
  ).rejects.toBe(canceled);
});

// Usefulness: verifies through the real read that a stalled `ps` with output in both streams ends
// on the cancel signal once the read runs, and on the bound, that `exec` ends the shim before its
// 10 s ceiling (11.2 s at most) after the cancel, and that the warning of the bound holds no output.
test.skipIf(process.platform === "win32")(
  "refuseHeldSessions ends a stalled read on cancel or bound and prints no output",
  async () => {
    await useShim(`echo ${SENTINEL}\necho ${SENTINEL} >&2\n__STALL__`);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const controller = new AbortController();
    const canceled = refuseHeldSessions(heldRoles(), { signal: controller.signal }).catch(
      (err) => err,
    );
    await shim.ready();
    const canceledAt = Date.now();
    controller.abort();
    // Primary evidence: the read rejected as canceled, well inside the 5 s force-kill delay.
    expect(await within(canceled, 20_000, "The canceled read")).toMatchObject({ isCanceled: true });
    expect(Date.now() - canceledAt).toBeLessThan(5000);
    // Secondary evidence: the heartbeat of the shim stopped and its marker is absent.
    expect(await shim.heartbeatStopped()).toBe(true);

    const boundedAt = Date.now();
    await within(refuseHeldSessions(heldRoles(), { timeout: 1 }), 20_000, "The bounded read");
    // The 1 s bound plus the 5 s force-kill delay of a SIGTERM-ignoring process.
    expect(Date.now() - boundedAt).toBeLessThan(12_000);
    const printed = warn.mock.calls.flat().join("\n");
    expect(printed).toContain("the process table read timed out after 1 second.");
    expect(printed).not.toContain(SENTINEL);
  },
  60_000,
);

// Usefulness: verifies the shared check applies the platform match to a process-table row, so a quoted flag or a session flag with the id refuses a run, and a bare id or a path that contains the id does not (#673). The match rules have their own tests in command-line.test.mjs.
test("refuseHeldIds refuses a holder by argument and passes a path that contains the id", async () => {
  const check = (command, platform) =>
    refuseHeldIds([{ role: "worker", sessionId: HELD_ID }], {
      platform,
      readProcessCommands: async () => [{ pid: 4242, command }],
    });
  await expect(check(`claude -p "--resume" ${HELD_ID}`, "win32")).rejects.toThrow("process 4242");
  await expect(check(`claude -p --session-id ${HELD_ID}`, "linux")).rejects.toThrow("process 4242");
  await expect(check(`claude ${HELD_ID}`, "linux")).resolves.toBeUndefined();
  await expect(check(`tail -f /logs/${HELD_ID}.log`, "linux")).resolves.toBeUndefined();
  await expect(check(`claude -p --resume ${HELD_ID}-copy`, "win32")).resolves.toBeUndefined();
});

// Usefulness: verifies the check reads and tokenizes each process command line once however many ids it matches, so the cost does not grow with ids times processes (#696). A counting getter stands in for the read of the command line.
test("refuseHeldIds reads each process command line once for many distinct ids", async () => {
  let reads = 0;
  const table = [
    {
      pid: 4242,
      get command() {
        reads += 1;
        return "claude -p";
      },
    },
  ];
  const entries = ["1", "2", "3", "4"].map((n) => ({
    role: "worker",
    sessionId: `${n.repeat(8)}-2222-4333-8444-555555555555`,
  }));
  await refuseHeldIds(entries, { platform: "linux", readProcessCommands: async () => table });
  expect(reads).toBe(1);
});

// Usefulness: verifies a repeated id gets one lookup per process, and that an uppercase copy is rejected by the UUID validator and never looked up, so archived state files that repeat one session id do not multiply the matches (#696, #716). A counting set stands in for the ids of a command line.
test("refuseHeldIds looks a repeated id up once per process", async () => {
  const lookups = [];
  const letteredId = "abcdef12-2222-4333-8444-555555555555";
  const entries = [letteredId, letteredId, letteredId.toUpperCase(), letteredId].map(
    (sessionId) => ({
      role: "worker",
      sessionId,
    }),
  );
  await refuseHeldIds(entries, {
    platform: "linux",
    readProcessCommands: async () => [
      { pid: 1, command: "claude -p" },
      { pid: 2, command: "claude -p" },
    ],
    heldSessionIds: () => ({ has: (id) => lookups.push(id) && false }),
  });
  expect(lookups).toEqual([letteredId, letteredId]);
});

// Usefulness: verifies a repeated id is checked once and still refuses a holder, so archived state files that repeat one session id do not multiply the work (#696).
test("refuseHeldIds checks a repeated id once and still refuses its holder", async () => {
  let reads = 0;
  const table = [
    {
      pid: 4242,
      get command() {
        reads += 1;
        return "claude -p";
      },
    },
  ];
  const repeated = Array.from({ length: 5 }, () => ({ role: "worker", sessionId: HELD_ID }));
  await refuseHeldIds(repeated, { platform: "linux", readProcessCommands: async () => table });
  expect(reads).toBe(1);

  const holder = [{ pid: 4343, command: `claude -p --resume ${HELD_ID.toUpperCase()}` }];
  await expect(
    refuseHeldIds(repeated, { platform: "linux", readProcessCommands: async () => holder }),
  ).rejects.toThrow("process 4343");
});
