import { fileURLToPath } from "node:url";

/**
 * Closing block every child turn must end with. The orchestrator sees only the child's final
 * response, so the block carries the reasoning and open items it would otherwise re-derive.
 */
export const reportBlock = `
End your response with this block, kept short. Each label takes one line, plain at column 0, so write no list. A list of dash-plus-one-space items (\`- item\`) directly under a label, empty or not, joins into that label's value. One level of sub-items under such an item, each a line of two spaces, a hyphen, one space, then the text, folds into that item with a comma. An ordered list (\`1. item\`) directly under a label joins into that label's value the same way, and its sub-items are dash lines indented to the column where the item text starts. A bold heading line that groups a dash list, with no label directly above the list, makes the block unparseable: put each group under one label instead. A blank line, then one plain prose line, then a dash list directly under it joins the label above as the prose, a colon, and the items. The prose line must not start with whitespace, an asterisk, an underscore, a backtick, a greater-than sign, or a hash, must not be a list, and must not hold a report label name or \`Verdict\`, in any case, followed by any run of asterisks, underscores, or backticks (or none), whitespace (or none), and a colon, anywhere in the line. Any other list or nesting, an indented label, or a decorated label makes the whole block unparseable. A line that starts with \`*\` either counts as a list or is dropped from the block, so write none:
Conclusion: one or two sentences.
Why: the decisive evidence behind the conclusion.
Blockers: anything unresolved that the next turn must know, or "none".
Checks: the commands that ran and their results, or "none". One line.
Notes: non-blocking findings the next turn does not need to act on, or "none".
Deferred: items found but left out of scope, or "none".
`.trim();

/**
 * Process rule for every worker and reviewer turn (issue #762). The dispatcher and the CLI of the
 * run carry the work tree path in their command lines, so a kill by name or by match can end the
 * run itself.
 */
export const processRule =
  "Never stop, kill, or signal a process that your own commands did not start, and never select processes by name or by a command-line match. End only the exact PIDs your own commands started.";

/**
 * Names the one way that a Codex shell command can reach the network despite the sandbox. The
 * orchestrator and reviewer prompts share it.
 */
export const SHELL_EXCEPTION =
  "A user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception. That rule can run a shell command with an expansion outside the sandbox, with network. The runtime does not prevent that.";

const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

// Characters that one of bash, PowerShell, and cmd expands or reinterprets inside
// a double-quoted argument, so a path holding one is not rendered:
// - `"` ends the string in all three, and PowerShell also ends it on the
//   typographic quotes U+201C, U+201D, and U+201E;
// - `$` and a backtick expand in bash and PowerShell;
// - `%` expands in cmd, and `!` expands in cmd with delayed expansion and in
//   interactive bash history;
// - a control character (Unicode category Cc), a line break included, ends or
//   corrupts the line;
// - U+2028 and U+2029, which every prompt escapes as text (escape.mjs), so the
//   rendered command would name another path. U+0085 is a control character.
// On Windows a backslash is a path separator and is rewritten to a slash first,
// so it is not listed. On POSIX it is a name character that bash reads as an
// escape inside double quotes, and the path cannot be rewritten without pointing
// at another path, so a POSIX path holding one is refused.
// known-limit: a non-ASCII path is rendered as is, and cmd reads it through its
// active code page.
const UNSAFE_IN_QUOTES = /["$`%!\u201C\u201D\u201E\u{2028}\u{2029}\p{Cc}]/u;
const UNSAFE_IN_QUOTES_POSIX = new RegExp(`${UNSAFE_IN_QUOTES.source}|\\\\`, "u");

/**
 * The commands that run the CLI of this process in each shell form, or null when a path cannot be
 * quoted the same way in every shell. `render` receives `paths`, each normalized like the Node
 * and CLI paths, and returns the arguments after the CLI script. The commands name the Node binary
 * and the CLI script that this process runs, so they resolve for a global install, an `npm link`,
 * and a clone run through `node <repo>/src/cli.mjs` or `pnpm agent-loop`, none of which promise
 * `agent-loop` on PATH (#348).
 *
 * A quoted executable path is a string expression in PowerShell and needs the call operator `&`,
 * while bash and cmd reject that operator, so Windows gets two forms. Probed on Windows: bash and
 * cmd run the plain form, PowerShell 5.1 and 7 run the `&` form, and each rejects the other's
 * form. Backslashes become slashes, which Node accepts on Windows.
 * @returns {Array<{ shell: string, command: string }> | null}
 */
export function cliCommandForms(
  render,
  { execPath = process.execPath, cliPath = CLI_PATH, platform = process.platform, paths = [] } = {},
) {
  const windows = platform === "win32";
  // Only a Windows path separator becomes a slash. A POSIX backslash is a name
  // character, and rewriting it would point the command at another path.
  const all = [execPath, cliPath, ...paths].map((path) =>
    windows ? path.replaceAll("\\", "/") : path,
  );
  const unsafe = windows ? UNSAFE_IN_QUOTES : UNSAFE_IN_QUOTES_POSIX;
  if (all.some((path) => unsafe.test(path))) return null;
  const [node, cli, ...rest] = all;
  const plain = `"${node}" "${cli}" ${render(...rest)}`;
  if (!windows) return [{ shell: "sh", command: plain }];
  return [
    { shell: "PowerShell", command: `& ${plain}` },
    { shell: "bash or cmd", command: plain },
  ];
}

const TARGETED_RUN_BOUND =
  "A targeted run is at most 10 test files that mirror the changed source files, never a whole directory.";

/**
 * The test-run rule for every worker and reviewer turn (issue #848, ADR 0040, issue #872, issue
 * #921, ADR 0044): a targeted test run of at most 10 files goes through the `test-slot` wrapper
 * of this process with `--if-held`, which runs it directly while all slots are free and waits for
 * a slot while any slot is held. Any broader run is a full suite and runs only through the plain
 * wrapper, or the required CI checks stand in for it. A path that cannot be quoted leaves a direct
 * targeted run and the CI checks.
 */
export function testSlotRule(options) {
  const forms = cliCommandForms(() => 'test-slot -- "<full suite command>"', options);
  if (forms === null) {
    return `Run a targeted test file directly. ${TARGETED_RUN_BOUND} Do not run a broader run or a full test suite in this run: rely on the required CI checks, because this run cannot render a test slot command for its paths.`;
  }
  const commands = forms.map(({ shell, command }) => `${shell}: ${command}`).join(" ; ");
  return `Run a targeted test file through the test slot wrapper with --if-held, which runs it directly while all slots are free and waits for a slot while any slot is held. ${TARGETED_RUN_BOUND} Run any broader run through the test slot wrapper, as a full suite. Run a full test suite only through the test slot wrapper, which waits for a free machine-wide test slot, or rely on the required CI checks. Use the command for the shell that your shell tool runs, with the suite command as one quoted argument: ${commands}. For a targeted run, put --if-held after test-slot and the targeted command in the quotes. Exit code 75 means that no slot was free within the wait bound and the command did not run: report it as unresolved, not as a pass or a failure.`;
}

/**
 * The init task as its own block of a first-turn preamble, with the blank line that separates it
 * from the next block. A null task gives no block, so a later turn never repeats the task.
 */
export function initTaskBlock(task) {
  return task === null || task === undefined ? "" : `Init task:\n${task}\n\n`;
}
