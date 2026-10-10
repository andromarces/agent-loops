// Reads a process command line for a held Claude session (#673, ADR 0032). The process table gives
// one string per process, and each platform builds it differently, so the split follows the platform.

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
 * True when `command` holds the session `id` through a session flag, compared without case: an
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
 * @param {string} id a UUID
 * @param {string} platform a `process.platform` value
 */
export function holdsSession(command, id, platform) {
  const args = (platform === "win32" ? splitWindowsArguments(command) : command.split(/\s+/)).map(
    (arg) => arg.toLowerCase(),
  );
  const wanted = id.toLowerCase();
  return args.some(
    (arg, i) =>
      SESSION_FLAGS.some((flag) => arg === `${flag}=${wanted}`) ||
      (SESSION_FLAGS.includes(arg) && args[i + 1] === wanted),
  );
}
