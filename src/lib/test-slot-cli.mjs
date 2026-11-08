// The `agent-loop test-slot` command (#847, ADR 0039). It parses its arguments, then runs one
// command only while it holds a machine-wide slot through `test-slot.mjs`.
import { statSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, extname, join } from "node:path";
import { killLiveTrees } from "./exec-tree.mjs";
import { execBounded } from "./exec.mjs";
import { logError, logInfo, setLogsToStderr } from "./log.mjs";
import { holdTestSlot, slotCount, testSlotOptions, usageError, waitSeconds } from "./test-slot.mjs";

const TEST_SLOT_USAGE_EXIT = 64;
const TEST_SLOT_TIMEOUT_EXIT = 75;

const TEST_SLOT_HELP = `
Usage:

  agent-loop test-slot [--if-held] [--slots <n>] [--wait <seconds>] [--] "<command>"
  agent-loop test-slot [--if-held] [--slots <n>] [--wait <seconds>] -- <executable> [<argument>...]

Runs a command only while this process holds one of the machine-wide test slots.
A wrapper starts only while fewer than its own <n> slots are held by live
owners, so wrappers that pass different <n> never run more than the largest
<n> among them. One argument after -- is a shell string, run through the
platform shell (/bin/sh -c, or cmd.exe on Windows) in the current directory, as
--test-cmd runs its command. Quote it as one argument for the calling shell.
Two or more arguments after -- form an argument vector, spawned without a
shell, so no shell quoting applies. On Windows the vector must start with a
real executable such as node. The wrapper accepts only a directly executable
.exe or .com, and refuses a .cmd or .bat shim such as pnpm, or a script that
needs an interpreter. stdout and stderr pass through, and stdin is closed.

Options:

  --slots <n>          Slot count. Defaults to 1 (ADR 0046).
                       Env: AGENT_LOOP_TEST_SLOTS.
  --wait <seconds>     Longest wait for a slot. Defaults to 1800 (30 minutes).
                       0 is one attempt: run if a slot is free now, else exit 75
                       at once. Env: AGENT_LOOP_TEST_SLOT_WAIT.
  --if-held            Run <command> directly, holding no slot, while no slot is
                       held by a live owner. While any slot is held, wait for a
                       slot as without the flag. The check is one read with no
                       lock: a command that starts while all slots are free holds
                       no slot, so another wrapper can start beside it (ADR 0044).
  -h, --help           Print this help.

A flag wins over its env, and an env value is read only when its flag is absent.
An empty env value counts as unset, and an invalid one is a usage error.
A value flag also accepts --slots=<n> and --wait=<seconds>.

Slots are lock files under <os tmpdir>/agent-loops/test-slots (env
AGENT_LOOP_TEST_SLOTS_ROOT overrides the directory). The directory is not per
user: where the OS temp directory is shared between users, as /tmp on Linux,
set AGENT_LOOP_TEST_SLOTS_ROOT to a directory per user. A slot whose owner
process is gone is reclaimed.

The command runs with AGENT_LOOP_TEST_SLOT_HELD set to its slot and owner. A
wrapper that starts with it set, while that slot is still held by that live
owner, runs its command at once in the same process group, so a nested call
cannot deadlock. Any other marker is ignored. SIGINT or SIGTERM ends the
command's process tree, then frees the slot.

Approved limits (ADR 0039, ADR 0044, docs/reference/usage.md#test-slot): a slot directory
shared between OS users, detached work that outlives the slot release, and on
POSIX a signal sent only to a nested wrapper, which can leave grandchildren.

Exit codes:

  <command's code>     The command ran. A command ended by a signal gives 128 + the signal number.
  64                   Usage error. The command did not run.
  75                   No slot was won within the wait bound. The command did not run.
  130, 143             SIGINT or SIGTERM reached the wrapper.
  1                    Any other wrapper failure, such as a slot directory that cannot be written.
`.trim();

/**
 * Parses the `test-slot` argv. A flag wins over its environment value, which is read only when
 * the flag is absent; an empty environment value counts as unset. Two or more arguments after `--`
 * form an argument vector, returned as `command` plus `args`; one argument keeps the shell-string
 * form, returned as `command` alone. Throws an error with `usage: true` on an invalid value that
 * applies.
 * @returns {{ help: true } | { slots: number, waitSeconds: number, ifHeld: boolean, command: string, args?: string[] }}
 */
export function parseTestSlotArgs(argv, env = process.env) {
  let slots = null;
  let wait = null;
  let ifHeld = false;
  let rest = [];
  let afterSeparator = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--if-held") {
      ifHeld = true;
      continue;
    }
    // A value flag also takes the inline `--flag=value` form, as every other value flag does.
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag === "--slots" || flag === "--wait") {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) {
        throw usageError(`${flag} needs a value.`);
      }
      if (flag === "--slots") {
        slots = slotCount(value, flag);
      } else {
        wait = waitSeconds(value, flag);
      }
      continue;
    }
    if (arg !== "--" && arg.startsWith("-")) {
      throw usageError(`Unknown option ${arg}.`);
    }
    afterSeparator = arg === "--";
    rest = argv.slice(afterSeparator ? i + 1 : i);
    break;
  }
  const commandForm =
    'Pass the command as one quoted argument, or as two or more arguments after "--" that run without a shell.';
  if (rest.length === 0 || rest[0].trim() === "") {
    throw usageError(commandForm);
  }
  if (afterSeparator && rest.length >= 2) {
    return {
      ...testSlotOptions(env, { slots, waitSeconds: wait }),
      ifHeld,
      command: rest[0],
      args: rest.slice(1),
    };
  }
  if (rest.length !== 1) {
    throw usageError(commandForm);
  }
  return { ...testSlotOptions(env, { slots, waitSeconds: wait }), ifHeld, command: rest[0] };
}

const signalExit = (name) => 128 + (constants.signals[name] ?? 0);

// On Windows, execa runs a `.cmd` or `.bat`, or a shebang script, through a shell even with
// `shell: false`. The vector form promises no shell, so it resolves the first element to a
// directly executable `.exe` or `.com` and refuses anything else. The resolution follows the
// current directory, PATH, and PATHEXT, as the OS and execa do. Synchronous, so the slot's
// wait-bound check stays the last await before the command starts.
function resolveWindowsCommand(command) {
  if (process.platform !== "win32") {
    return command;
  }
  const extension = extname(command).toLowerCase();
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasSeparator = command.includes("/") || command.includes("\\");
  const bases = hasSeparator
    ? [command]
    : [process.cwd(), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)].map((dir) =>
        join(dir, command),
      );
  const candidates =
    extension !== ""
      ? bases
      : bases.flatMap((base) => [base, ...extensions.map((ext) => `${base}${ext.toLowerCase()}`)]);
  for (const candidate of candidates) {
    let stats;
    try {
      stats = statSync(candidate);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    return /\.(?:com|exe)$/i.test(candidate) ? candidate : null;
  }
  return null;
}

// Runs the command with the `--test-cmd` runner semantics: a shell string in the platform shell,
// or an argument vector spawned without a shell, and a tree that `killLiveTrees` ends. A top-level
// run leads a process group of its own on POSIX. A nested run (`ownGroup` false) stays in the
// group of the outer wrapper's command, so the outer kill reaches it. The command text is never
// logged.
async function runCommand({ command, args }, { env, ownGroup }) {
  const executable = args === undefined ? command : resolveWindowsCommand(command);
  if (executable === null) {
    logError(
      "test slot command did not start: the argument vector must start with a real executable such as node, not a .cmd, .bat, or script that needs an interpreter",
    );
    return 1;
  }
  logInfo("test slot command started");
  const result = await execBounded(executable, args ?? [], {
    shell: args === undefined,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env,
    killDescendants: ownGroup,
  });
  if (typeof result.exitCode === "number") {
    logInfo(`test slot command finished: exit ${result.exitCode}`);
    return result.exitCode;
  }
  if (result.signal) {
    logInfo(`test slot command finished: signal ${result.signal}`);
    return signalExit(result.signal);
  }
  logError(`test slot command did not start: ${result.code ?? "unknown error"}`);
  return 1;
}

/**
 * Runs `agent-loop test-slot` and returns its exit code (see `TEST_SLOT_HELP`). Side effects:
 * creates and removes a slot lock file, routes every log line to stderr, and listens for SIGINT
 * and SIGTERM until it returns. A signal ends the command's process tree before the slot is freed.
 */
export async function runTestSlot(argv) {
  setLogsToStderr(true);
  let options;
  try {
    options = parseTestSlotArgs(argv);
  } catch (err) {
    if (!err.usage) {
      throw err;
    }
    logError(err.message);
    return TEST_SLOT_USAGE_EXIT;
  }
  if (options.help) {
    console.log(TEST_SLOT_HELP);
    return 0;
  }

  const controller = new AbortController();
  let received = null;
  const onSignal = (name) => {
    received ??= name;
    controller.abort();
    killLiveTrees();
  };
  // A run that a signal reached exits with the code of that signal, whatever the killed command
  // returned.
  const run = async (env, ownGroup) => {
    const code = received ? null : await runCommand(options, { env, ownGroup });
    return received ? signalExit(received) : code;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    let slot;
    try {
      slot = await holdTestSlot({ ...options, signal: controller.signal });
    } catch (err) {
      logError(`test slot acquisition failed; the command did not run: ${err?.message ?? err}`);
      return 1;
    }
    if (slot === null) {
      if (received) {
        return signalExit(received);
      }
      logError(`no test slot won within ${options.waitSeconds}s; the command did not run`);
      return TEST_SLOT_TIMEOUT_EXIT;
    }
    try {
      return await run(slot.env, !slot.nested);
    } finally {
      await slot.release();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
