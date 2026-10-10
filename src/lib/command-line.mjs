// Reads a process command line for a held Claude session (#673, ADR 0031). The process table gives
// one string per process, and each platform builds it differently, so the split follows the platform.

/**
 * Splits a Windows command line into arguments with the argument parser of the C runtime, which
 * gives `process.argv` in Node and which the native `claude.exe` uses (ADR 0031). Space and tab
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

/** The last path segment without its extension, lower-cased. */
function stem(path) {
  return path
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|js|mjs|cjs)$/, "");
}

/**
 * True when the arguments before the first option name a Claude CLI: an executable or an entry
 * script whose name is `claude`, or a path under the `claude-code` package directory. The adapter
 * starts `claude`, which resolves to `claude.exe`, to the `claude` binary, or to a Node entry
 * script of the npm package (`src/agents/claude.mjs`). A real child of this adapter shows as
 * `claude -p --session-id <id>`. Any other program is not a holder, whatever its arguments hold.
 * known-limit: a Claude CLI started through another launcher or under another name is not found.
 */
function isClaudeCli(args) {
  const firstOption = args.findIndex((arg) => arg.startsWith("-"));
  return args
    .slice(0, firstOption === -1 ? args.length : firstOption)
    .some((arg) => stem(arg) === "claude" || /(^|[\\/])claude-code([\\/]|$)/i.test(arg));
}

/**
 * True when `command` is a Claude CLI process that holds the session `id`: an argument equals the
 * id, or is `--resume=<id>`, `--session-id=<id>`, or `-r=<id>`, compared without case. A path or a
 * longer token that merely contains the id does not count, and a process that is not a Claude CLI
 * never counts.
 *
 * Windows: the arguments come from the C runtime parser. POSIX: `ps` prints the arguments joined by
 * single spaces with no quoting, so the boundaries are lost. The text is split on white space only,
 * because a quote in it can be a literal character of an earlier argument, and a UUID holds no
 * white space, so the id of a holder is one field.
 * known-limit: on POSIX an argument that holds spaces and has the id as a separate word counts in
 * a Claude CLI process, which refuses a run on the safe side.
 * @param {string} command
 * @param {string} id a UUID
 * @param {string} platform a `process.platform` value
 */
export function holdsSession(command, id, platform) {
  const args =
    platform === "win32" ? splitWindowsArguments(command) : command.split(/\s+/).filter(Boolean);
  if (!isClaudeCli(args)) {
    return false;
  }
  const wanted = id.toLowerCase();
  const accepted = new Set([
    wanted,
    `--resume=${wanted}`,
    `--session-id=${wanted}`,
    `-r=${wanted}`,
  ]);
  return args.some((arg) => accepted.has(arg.toLowerCase()));
}
