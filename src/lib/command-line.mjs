// Reads a process command line for a held Claude session (#673, ADR 0032). The process table gives
// one string per process, and each platform builds it differently, so the split follows the platform.

import { readProp } from "./error-message.mjs";
import { ROLE_KINDS } from "./args.mjs";
import { logWarn } from "./log.mjs";
import { ProcessReadError, readProcessCommands } from "./process-ancestry.mjs";
import { isUuid } from "./session-record.mjs";

/**
 * Splits a Windows command line into arguments with the argument parser of the C runtime, which
 * gives `process.argv` in Node and which the native `claude.exe` uses (ADR 0032). Space and tab
 * separate arguments outside quotes, a quote toggles the quoted section and is dropped, `2n`
 * backslashes before a quote give `n` backslashes and the quote acts, `2n+1` give `n` backslashes
 * and a literal quote, other backslashes stay, and a doubled quote inside a quoted section gives a
 * literal quote and keeps the section open. `CommandLineToArgvW` leaves the section there, so it
 * reads some lines differently. The program name is parsed as an argument, which matches the
 * runtime for a path that does not end in a backslash.
 * @param {string} command
 * @returns {string[]}
 */
export function splitWindowsArguments(command) {
  const args = [];
  let current = "";
  let started = false;
  let inQuotes = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "\\") {
      let n = 0;
      while (command[i + n] === "\\") n++;
      i += n;
      started = true;
      if (command[i] !== '"') {
        current += "\\".repeat(n);
      } else if (n % 2 === 1) {
        current += `${"\\".repeat((n - 1) / 2)}"`;
        i++;
      } else {
        current += "\\".repeat(n / 2);
      }
    } else if (c === '"') {
      started = true;
      if (inQuotes && command[i + 1] === '"') {
        current += '"';
        i += 2;
      } else {
        inQuotes = !inQuotes;
        i++;
      }
    } else if (!inQuotes && (c === " " || c === "\t")) {
      if (started) args.push(current);
      current = "";
      started = false;
      i++;
    } else {
      current += c;
      started = true;
      i++;
    }
  }
  if (started) args.push(current);
  return args;
}

const SESSION_FLAGS = ["--session-id", "--resume", "-r"];

/**
 * The lower-case ids that `command` holds through a session flag: an
 * argument `--session-id`, `--resume`, or `-r` immediately followed by an argument equal to the id,
 * or one argument `--session-id=<id>`, `--resume=<id>`, or `-r=<id>`. The adapter passes the id
 * only so, as `--resume <id>` or `--session-id <id>` (`src/agents/claude.mjs`). A bare id argument,
 * a path or a longer token that contains the id, and a flag that is not one of these never count,
 * and the program is not examined (ADR 0032).
 *
 * Windows: the arguments come from the C runtime parser, so quotes are stripped. POSIX: `ps` prints
 * the arguments joined by single spaces with no quoting, so the boundaries are lost. The text is
 * split on white space only, because a quote in it can be a literal character of an earlier
 * argument, and a UUID holds no white space, so the id of a holder is one field.
 * known-limit: a holder that does not carry a session flag is not found. On POSIX a flag and an id
 * that sit inside one argument that holds spaces, for example a prompt text, count as a holder,
 * which refuses a run on the safe side.
 * @param {string} command
 * @param {string} platform a `process.platform` value
 * @returns {Set<string>} the ids in lower case, from one tokenization of `command`
 */
export function heldSessionIds(command, platform) {
  const args = (platform === "win32" ? splitWindowsArguments(command) : command.split(/\s+/)).map(
    (arg) => arg.toLowerCase(),
  );
  const ids = new Set();
  args.forEach((arg, i) => {
    if (SESSION_FLAGS.includes(arg)) {
      if (i + 1 < args.length) ids.add(args[i + 1]);
      return;
    }
    for (const flag of SESSION_FLAGS) {
      if (arg.startsWith(`${flag}=`)) ids.add(arg.slice(flag.length + 1));
    }
  });
  return ids;
}

/**
 * Refuses a continuation when a live process passes the id of a claude role session through a
 * session flag in its command line (#647, #671, #673, ADR 0031, ADR 0032, `heldSessionIds`). A
 * `SIGKILL` of the earlier parent leaves its `claude` child
 * running, and the CLI accepts a resume of that session, so two processes would write one session
 * file. Only a claude id in the UUID form is checked, so a short id cannot match another
 * command line. No other adapter is verified to leave such an orphan. A process table that cannot
 * be read logs a warning and lets the run continue. The read is bounded by `deps.timeout`
 * (seconds) and ends on `deps.signal`. A cancel rejects, so SIGINT still cancels the run.
 * `deps.flag` names the flag in the messages (`--continue-from` by default). A role that is absent
 * from `roles` is skipped, so the interactive path passes only the role it resumes.
 * known-limit: the match is by command line, so a holder that does not carry a session flag is not found.
 * @param {object} roles roles keyed by role name, after `restoreSessions`
 * @param {{ readProcessCommands?: (options: { signal?: AbortSignal, timeout?: number }) => Promise<{ pid: number, command: string }[]>, signal?: AbortSignal, timeout?: number, flag?: string, platform?: string }} [deps]
 */
export async function refuseHeldSessions(roles, deps = {}) {
  await refuseHeldIds(
    ROLE_KINDS.filter((role) => roles[role]?.kind === "claude").map((role) => ({
      role,
      sessionId: roles[role].sessionId,
    })),
    { ...deps, label: deps.flag ?? "--continue-from" },
  );
}

/**
 * The check of `refuseHeldSessions` for a list of `{ role, sessionId }` entries of claude roles.
 * `deps.label` prefixes the warning and the refusal. `deps.platform` (default `process.platform`)
 * selects the command-line rules. `deps.heldSessionIds` (default `heldSessionIds`) reads the ids of one command line. Entries whose id is not a UUID are ignored, and an id that repeats is checked once. `isUuid` accepts lowercase ids only, so an exact match is enough.
 */
export async function refuseHeldIds(entries, deps = {}) {
  const roleById = new Map();
  for (const { role, sessionId } of entries) {
    if (isUuid(sessionId) && !roleById.has(sessionId)) {
      roleById.set(sessionId, role);
    }
  }
  if (roleById.size === 0) {
    return;
  }
  const label = deps.label ?? "session check";
  let table;
  try {
    table = await (deps.readProcessCommands ?? readProcessCommands)({
      signal: deps.signal,
      timeout: deps.timeout,
    });
  } catch (err) {
    if (readProp(err, "isCanceled")) {
      throw err;
    }
    // Only the reason class of a `ProcessReadError` is printed: the process table holds the command
    // lines of every process on the host.
    logWarn(
      `${label}: cannot check for a live holder of a session: the process table read ${err instanceof ProcessReadError ? err.reason : "failed"}.`,
    );
    return;
  }
  // Each command line is tokenized once, then every id is looked up in the tokens.
  const platform = deps.platform ?? process.platform;
  const held = table
    .filter((entry) => entry.pid !== process.pid)
    .map((entry) => ({
      pid: entry.pid,
      ids: (deps.heldSessionIds ?? heldSessionIds)(entry.command, platform),
    }));
  for (const [id, role] of roleById) {
    const holder = held.find((entry) => entry.ids.has(id));
    if (holder) {
      throw new Error(
        `${label}: the ${role} session ${id} is held by process ${holder.pid}, a leftover of an earlier run. End that process, or wait for it to finish, and run again.`,
      );
    }
  }
}
