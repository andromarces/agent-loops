// Reads a process command line for a held Claude session (#673, ADR 0031). The process table gives
// one string per process, and each platform builds it differently, so the split follows the platform.

/**
 * Splits a Windows command line into arguments. A process can read its command line with the argument
 * parser of the C runtime (`parser: "crt"`, which gives `process.argv` in Node) or with
 * `CommandLineToArgvW` (`parser: "shell32"`). They agree except for a doubled quote inside a quoted
 * section, where both give a literal quote and the CRT stays in the section while `shell32` leaves it.
 * Shared rules: space and tab separate arguments outside quotes, a quote toggles the quoted section
 * and is dropped, `2n` backslashes before a quote give `n` backslashes and the quote acts, `2n+1`
 * give `n` backslashes and a literal quote, and other backslashes stay. The program name is parsed
 * as an argument, which matches the native parsers for a path that does not end in a backslash.
 * @param {string} command
 * @param {"crt" | "shell32"} parser
 * @returns {string[]}
 */
export function splitWindowsArguments(command, parser) {
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
        if (parser === "shell32") inQuotes = false;
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

/**
 * True when a process holds the session `id`: an argument of its command line equals the id, or is
 * `--resume=<id>`, `--session-id=<id>`, or `-r=<id>`, compared without case. A path or a longer
 * token that merely contains the id does not count.
 *
 * Windows: the arguments come from both native parsers, so a holder is found under either. POSIX:
 * `ps` prints the arguments joined by single spaces with no quoting, so the boundaries are lost.
 * The text is split on white space only, because a quote in it can be a literal character of an
 * earlier argument, and a UUID holds no white space, so the id of a holder is one field.
 * known-limit: on POSIX an argument that holds spaces and has the id as a separate word counts,
 * which refuses a run on the safe side.
 * @param {string} command
 * @param {string} id a UUID
 * @param {string} platform a `process.platform` value
 */
export function holdsSession(command, id, platform) {
  const wanted = id.toLowerCase();
  const accepted = new Set([
    wanted,
    `--resume=${wanted}`,
    `--session-id=${wanted}`,
    `-r=${wanted}`,
  ]);
  const argumentSets =
    platform === "win32"
      ? [splitWindowsArguments(command, "crt"), splitWindowsArguments(command, "shell32")]
      : [command.split(/\s+/)];
  return argumentSets.some((args) => args.some((arg) => accepted.has(arg.toLowerCase())));
}
