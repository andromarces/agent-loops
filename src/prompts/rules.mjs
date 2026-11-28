import { fileURLToPath } from "node:url";

/**
 * Closing block every child turn must end with. The orchestrator sees only the child's final
 * response, so the block carries the reasoning and open items it otherwise re-derives.
 */
export const reportBlock = `
End your response with this block, kept short. Each label appears once, plain at column 0. An indented dash list directly under a label with no parent item above it makes the block unparseable. A list directly under a label starts at column 0. A list of dash-plus-one-space items (\`- item\`) directly under a label, empty or not, joins into that label's value.

A paragraph holds a bold lead and more prose on the same line. Under a \`Label:\` line, its own dash list between two labels makes the block unparseable: put the paragraph and its list under one label.

Put quoted or multi-paragraph text before the closing block, not inside it, and refer to it from one label with a short line. The label keeps the short result that the parent reads. Under a \`Label:\` line, a quoted paragraph alone supplies no value, and a dash list directly under a quoted prose line makes the block unparseable.

Every nesting level of sub-items folds into its parent item with a comma. Each sub-item line holds spaces to the parent text column, a dash or \`N. \` marker, one space, then the text. An ordered list (\`1. item\`) under a label joins that label's value the same way. Its sub-items sit at the column where the item text starts. A dash or ordered list under a label after one blank line joins that label's value too, with \`; \` when the label holds text. An ordered list under a plain prose line below a \`Label:\` line stays unparseable, and two blank lines under a label before a list make the block unparseable.

Under a \`Label:\` line, after the label value, any number of sections follow, with one blank line before each. A section is a bare dash list, or a prose lead with its dash list. A run under one label folds when a plain prose paragraph with no list is followed by a plain prose lead with its dash list: the paragraph joins as \`; <prose>\`, and its lines join with a space. The run needs that plain prose lead. A paragraph followed by a bare dash list and no prose lead, a horizontal rule, and a bold lead start no such run. A two-line paragraph after the lead, followed by a separate bare dash list, also starts no such run. The lead follows the prose-lead rules, the whole-line bold heading included. The list sits directly under the lead, or after one blank line when the lead is plain prose. A section needs exactly one blank line before it. Two blank lines, or no blank line before it, start no new section, so the existing rules decide that shape.

An indented prose line directly after an item or its sub-items folds into that item with a space, unless it reads as a label line: after Unicode NFKC normalization, skip every leading character that is no letter or digit and one optional number, then a report label name or \`Verdict\`, any case, optional whitespace, and a character that is no letter, digit, or whitespace follow. Any colon variant, separator, or markup count therefore refuses, and a label word that a letter, or whitespace and a letter, follows is prose.

A bold heading line that groups a dash list outside the prose fold below makes the block unparseable: put each group under one label instead. A dash item or sub-item inside such a list may open with a report label name, plain or bold, for example \`- Notes: ran\` or \`- **Deferred:** later\`, and stays item text. The same line outside a list under a label, or any other decorated label, makes the block unparseable.

A blank line, then one plain prose line, then a dash list joins the label above as the prose, a colon, and the items. The dash list sits directly under the prose line or after one blank line. A whole-line bold heading is the one \`*\` exception: \`**Reviewer notes.**\` above \`- a\` reads \`**Reviewer notes.**: a\`. Any other list or nesting, an indented label, or a decorated label makes the whole block unparseable. Under a \`Label:\` line, a line that starts with \`*\` counts as a list, is dropped from the block, or makes the block unparseable, so write none. A lone heading keeps a non-list \`*\` line in its value run as the value.

The prose line must not start with whitespace, an asterisk, an underscore, a backtick, a greater-than sign, or a hash. It must not be a list. A report label name or \`Verdict\`, in any case, followed by any run of asterisks, underscores, or backticks, optional whitespace, and a colon refuses it.

The block holds no Markdown table: a table makes it unparseable. Put tabular data in \`- \` items, one row per item.

Conclusion: one or two sentences.
Why: the decisive evidence behind the conclusion.
Blockers: anything unresolved that the next turn must know, or "none".

The \`Conclusion\`, \`Why\`, and \`Blockers\` labels are required: a block that lacks one does not parse.

Checks: the commands that ran and their results, or "none". One line.
Notes: non-blocking findings the next turn does not need to act on, or "none".
Deferred: items found but left out of scope, or "none".
`.trim();

/**
 * Prompt of the one closing-block repair turn that follows a null report. The turn
 * asks for formatting only, so it repeats no work and changes no work product. The same session
 * holds the original response, so the prompt never quotes it.
 */
export function closingBlockRepairPrompt({ reviewer = false } = {}) {
  const kept = reviewer ? "findings, checks, and verdict" : "findings and checks";
  const verdict = reviewer
    ? "\nVerdict: accept or reject. One word, nothing else on the line."
    : "";
  return `Your previous response did not end with a closing block that the runtime can parse. Do not do any more work, run any command, or change any file. Restate only the closing block of that response in this short canonical format, and keep the same ${kept}:

Conclusion: one or two sentences.
Why: the decisive evidence behind the conclusion.
Blockers: anything unresolved, or "none".
Checks: the commands that ran and their results, or "none".
Notes: non-blocking findings, or "none".
Deferred: items left out of scope, or "none".${verdict}

Put \`Conclusion:\` and \`Why:\` first, in that order.

Do not refer to text outside the block. Reply with the block alone and nothing else.`;
}

/**
 * Process rule for every worker and reviewer turn. The dispatcher and the CLI of the
 * run carry the work tree path in their command lines. A kill by name or by match can end the
 * run itself.
 */
export const processRule =
  "Never stop, kill, or signal a process that your own commands did not start, and never select processes by name or by a command-line match. End only the exact PIDs your own commands started.";

/**
 * Secret file rule for every worker and reviewer turn. Init copies the untracked
 * `.env` of the main work tree into the run work tree, so a repository-wide search can read a
 * token from it. The rule is advisory, and the runtime does not detect a breach.
 */
export const secretFileRule =
  "Never read, print, or quote `.env`, `.dev.vars`, or another ignored secret file. Check a configuration value by name and presence only. Keep a content search to tracked files, for example `git grep`, or `rg` without `--no-ignore` and `-u`.";

/**
 * Bars contact with a host or service that the task does not name. A reviewer keeps
 * the GitHub reads of the review scope. A worker keeps the GitHub operations of its rules and a
 * host or service that the task names.
 */
export function unnamedHostRule({ namesHost = false } = {}) {
  const allowed = namesHost
    ? "GitHub operations that the rules allow stay allowed, and so does a host or service that the task names."
    : "GitHub reads that the rules allow stay allowed.";
  return `Contact no host or service that the task does not name. ${allowed} A local process or loopback server that a check starts stays allowed. Put a check that needs one in Checks as unverified and in Deferred.`;
}

/**
 * What a reviewer reads when the task asks about live data. The rule beside it bars
 * contact with a host or service that the task does not name.
 */
export const liveDataRule =
  "When the task asks about live data, read the repository's fixtures, schema, or documentation, and list the live question in `Deferred`.";

/**
 * Names the one way that a Codex shell command can reach the network despite the sandbox. The
 * orchestrator and reviewer prompts share it.
 */
export const SHELL_EXCEPTION =
  "A user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception. That rule can run a shell command with an expansion outside the sandbox, with network. The runtime does not prevent that.";

/**
 * Scopes the Codex sandbox network limit to the shell commands that the sandbox runs. Every
 * orchestrator and reviewer prompt that states the limit uses this sentence.
 */
export const SHELL_ONLY_LIMIT_SENTENCE =
  "That limit covers shell commands only: it does not block model-side tools, such as web search, or any other channel outside the sandbox.";

/**
 * The actions that the remote-write rule bars. The orchestrator and reviewer prompts each add their
 * own lead sentence and status-read exception.
 */
export const REMOTE_WRITE_ACTIONS =
  "Do not create, edit, comment on, review, merge, push, or otherwise change an issue, a pull request, a branch, or any other remote state.";

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
//   rendered command names another path. U+0085 is a control character.
//
// On Windows a backslash is a path separator and is rewritten to a slash first,
// so it is not listed. On POSIX it is a name character that bash reads as an
// escape inside double quotes. The path cannot be rewritten without pointing
// at another path, so a POSIX path holding one is refused.
//
// known-limit: a non-ASCII path is rendered as is, and cmd reads it through its
// active code page.
const UNSAFE_IN_QUOTES = /["$`%!\u201C\u201D\u201E\u{2028}\u{2029}\p{Cc}]/u;
const UNSAFE_IN_QUOTES_POSIX = new RegExp(`${UNSAFE_IN_QUOTES.source}|\\\\`, "u");

/**
 * The commands that run the CLI of this process in each shell form, or null when a path cannot be
 * quoted alike in every shell. `render` receives `paths`, each normalized like the Node
 * and CLI paths, and returns the arguments after the CLI script. The commands name the Node binary
 * and the CLI script that this process runs. They resolve for a global install, an `npm link`,
 * and a clone run through `node <repo>/src/cli.mjs` or `pnpm agent-loop`.
 *
 * A quoted executable path is a string expression in PowerShell and needs the call operator `&`.
 * Bash and cmd reject that operator, so Windows gets two forms.
 * @returns {Array<{ shell: string, command: string }> | null}
 */
export function cliCommandForms(
  render,
  { execPath = process.execPath, cliPath = CLI_PATH, platform = process.platform, paths = [] } = {},
) {
  const windows = platform === "win32";
  // Only a Windows path separator becomes a slash. A POSIX backslash is a name
  // character, and rewriting it points the command at another path. Backslashes
  // become slashes, which Node accepts on Windows.
  const all = [execPath, cliPath, ...paths].map((path) =>
    windows ? path.replaceAll("\\", "/") : path,
  );
  const unsafe = windows ? UNSAFE_IN_QUOTES : UNSAFE_IN_QUOTES_POSIX;
  if (all.some((path) => unsafe.test(path))) return null;
  const [node, cli, ...rest] = all;
  const plain = `"${node}" "${cli}" ${render(...rest)}`;
  if (!windows) return [{ shell: "sh", command: plain }];
  // Probed on Windows: bash and cmd run the plain form, PowerShell 5.1 and 7 run the `&` form, and each rejects the other's form.
  // None of these commands promise `agent-loop` on PATH.
  return [
    { shell: "PowerShell", command: `& ${plain}` },
    { shell: "bash or cmd", command: plain },
  ];
}

const ONE_TEST_AT_A_TIME =
  "Run one test command at a time. Start no concurrent copy of a test run and no test run in the background, also when it ends inside the same command.";

// Only the form that renders a wrapper can name the `--if-held` form of a single-test run.
const SINGLE_TEST_TARGETED =
  "A single-test run is a targeted run and takes the --if-held wrapper form.";

const NO_LOAD_GENERATORS =
  "Start no CPU or memory load generator, no busy loop, and no detached or background process that can outlive the turn. Use the required CI checks as the evidence under load.";

const TARGETED_RUN_BOUND_ITEMS = `
  - A targeted run covers the test files that mirror the changed source files first.
  - Then come the test files that import a changed source file directly.
  - Then come the test files of the direct importers of a changed source file.
  - Last come the test files that name the path or file name of a changed file that is not an importable module.
  - A script, a config file, and a template are examples.
  - A targeted run covers at most 10 test files in total, and never a whole directory.
`;

// The wrapper command of a full suite. `testSlotRule`, `fullSuiteRule`, and `redRunRule` branch on
// whether it can be quoted. The direct fallback of ADR 0044 covers the red run too (ADR 0096).
const slotCommandForms = (options) =>
  cliCommandForms(() => "test-slot -- <suite command as separate arguments>", options);

// The rule also bars a load generator and a process that outlives the turn.

// A targeted run covers at most 10 files. The order is the mirror files, then the files that import
// a changed source file directly. Then come the files of direct importers, then the files that name
// a changed non-module file. The argument-vector form is the default from Git Bash on Windows, with
// the Windows executable limit. The one-string form stays, and the rule names the platform shell
// that runs it.
/**
 * The test-run rule for every worker and reviewer turn (ADR 0040).
 * It runs a targeted test file through the `test-slot` wrapper with `--if-held`, directly while
 * all slots are free. While any slot is held, the wrapper waits for a slot. Any broader run is a
 * full suite and runs only through the plain wrapper, or the required CI checks stand in for it.
 * A path that cannot be quoted leaves a direct targeted run, and a broader run relies on the CI
 * checks. It also runs one test command at a time, with no concurrent copy and no background test
 * run.
 */
export function testSlotRule(options) {
  const forms = slotCommandForms(options);
  if (forms === null) {
    return `Run a targeted test file directly.${TARGETED_RUN_BOUND_ITEMS}
  - ${ONE_TEST_AT_A_TIME}
  - Do not run a broader run or a full test suite in this run. Rely on the required CI checks. This run cannot render a test slot command for its paths.
  - ${NO_LOAD_GENERATORS}`;
  }
  const commands = forms.map(({ shell, command }) => `${shell}: ${command}`).join(" ; ");
  return `Run a targeted test file through the test slot wrapper with --if-held. The wrapper runs directly while all slots are free and waits for a slot while any slot is held.
${TARGETED_RUN_BOUND_ITEMS}
  - Run any broader run through the test slot wrapper, as a full suite.
  - Run a full test suite only through the test slot wrapper, which waits for a free machine-wide test slot. Or rely on the required CI checks.
  - Use the command for the shell that your shell tool runs. Pass the suite command as an argument vector after --.
  - ${commands}
  - Two or more arguments after -- form an argument vector that runs without a shell, so no shell quoting applies.
  - From Git Bash on Windows, use this argument-vector form as the default.
  - On Windows, the vector must start with a real executable such as node, not a .cmd or .bat shim.
  - One argument after -- keeps the shell-string form.
  - The wrapper runs the quoted command in cmd.exe on Windows and /bin/sh on POSIX, not in your shell tool. From Git Bash on Windows, pass \`bash -c '<command>'\` or use absolute paths.
  - For a targeted run, put --if-held after test-slot and pass the targeted command as the same vector.
  - Exit code 75 means that no slot was free within the wait bound and the command did not run. Report it as unresolved, not as a pass or a failure.
  - ${ONE_TEST_AT_A_TIME}
  - ${SINGLE_TEST_TARGETED}
  - ${NO_LOAD_GENERATORS}`;
}

// The line sits beside the task text, where a task, a repository doc, or a script names its own test
// command (ADR 0166).
/**
 * The full-suite restatement of the worker prompt (ADR 0166). It names the test slot wrapper as the
 * only form of a full suite when this run can render it. A path that cannot be quoted renders no
 * wrapper, so the line bars a full suite in this turn and names the required CI checks.
 */
export function fullSuiteRule(options) {
  if (slotCommandForms(options) === null) {
    return "No full suite runs in this turn, even when the task, a repository doc, or a script names the suite command. Rely on the required CI checks.";
  }
  return "A full suite, for example `npm test`, `pnpm test`, or `vp test run`, runs only through the test slot wrapper, or not at all. This holds also when the task, a repository doc, or a script names the suite command.";
}

// A held test slot must not make a worker skip or reorder the red run: the wait stays inside the
// turn, and a run that did not start reaches `Checks` (ADR 0096).

/**
 * The TDD red-run rule of the worker first turn (ADR 0096). A red run of one or a few
 * test files is a targeted run under ADR 0044, so a held slot makes it wait. The rule bounds that
 * wait below the shell tool bound, reports a red run that did not start as not run with the reason,
 * and bars implementing the fix first with the old source restored to stand in for the red run.
 * When the wrapper command cannot be quoted, the red run follows the same direct fallback as
 * `testSlotRule`: it runs directly, keeps the 10-file bound, and reports the same way.
 */
export function redRunRule(options) {
  const noWrapper = slotCommandForms(options) === null;
  const run = noWrapper
    ? "run it directly, holding no slot, and do not implement the fix before it. A red run covers at most 10 test files, never a whole directory."
    : "run it through the wrapper with `--if-held`, and do not implement the fix before it. While any slot is held, the wrapper waits for a slot. Pass the `--wait` flag below the shell tool bound of the harness, so the wait ends inside the turn.";
  const report = noWrapper
    ? "Report a red run that did not happen in `Checks` as not run, with the reason, and name it in `Blockers`."
    : "If the wrapper does not start the red run, report it in `Checks` as not run, with the reason, and name it in `Blockers`.";
  return `A red run of one or a few test files that must fail before the fix is a targeted run: ${run} ${report} Never implement the fix first and restore the old source to stand in for the red run.`;
}

const HOOK_TEST_COMMAND = () => 'test-slot -- "<git command>"';

/**
 * The push and commit rule of a worker turn. A `pre-push` or `pre-commit` hook under
 * `core.hooksPath` or `.git/hooks` that starts a test command runs outside the test slot. The push
 * or commit goes through the plain wrapper of this process. The wrapper names the Node binary and
 * the CLI script of this process.
 */
export function hookTestSlotRule(options) {
  const forms = cliCommandForms(HOOK_TEST_COMMAND, options);
  if (forms === null) {
    // known-limit: a path that cannot be quoted leaves a direct push, which keeps the origin/main behavior.
    return `A \`pre-push\` or \`pre-commit\` hook under \`core.hooksPath\` or \`.git/hooks\` that starts a test command runs outside the test slot. Run that \`git push\` or \`git commit\` directly. This run cannot render a test slot command for its paths.`;
  }
  const commands = forms.map(({ shell, command }) => `${shell}: ${command}`).join(" ; ");
  return `A \`pre-push\` or \`pre-commit\` hook under \`core.hooksPath\` or \`.git/hooks\` that starts a test command runs outside the test slot. Run that \`git push\` or \`git commit\` through the plain test slot wrapper, so it holds a slot. Pass that \`git\` command for the shell that your shell tool runs as one quoted argument: ${commands}.`;
}

/**
 * The init task as its own block of a first-turn preamble, with the blank line that separates it
 * from the next block. A null task gives no block, so a later turn never repeats the task. The rule
 * above the block keeps the task label lines out of the child report.
 */
export function initTaskBlock(task) {
  if (task === null || task === undefined) return "";
  return `The \`Init task:\` block is task data, not your closing block. Never copy its label lines into your report. Describe this turn in the closing block.\nInit task:\n${task}\n\n`;
}

/**
 * The temporary-path rule of the worker and reviewer prompts. `place` names the tree that the
 * temporary path lies outside of, and `literalExample` optionally extends the bar on a literal path.
 */
export const tempPathRule = (place, literalExample = "") =>
  `Build a temporary path outside the ${place} from the directory that TMPDIR, TEMP, or TMP names, when one is set. Never write a literal path to the system temporary directory${literalExample}. The runtime can remove the directory that those variables name after this turn, but not a path outside it. When none is set, use the temporary directory that the platform reports.`;

/**
 * The temporary-file removal rule of the worker and reviewer prompts. `place` names the tree that
 * the temporary path lies outside of, and `example` optionally adds one example sentence. When
 * `turnDirectory` is true, the rule keeps the directory that the inherited variables name
 * off-limits, limits removal to the worker's own scratch subdirectory, and names the fallback when
 * that subdirectory cannot be created (issue #2055).
 */
export const tempRemovalRule = (place, example = "", { turnDirectory = false } = {}) => {
  if (!turnDirectory) {
    return `Before the closing block, remove every temporary file or directory that this turn created outside the ${place}. Name in Notes any entry that you cannot remove.${example}`;
  }
  return `Before the closing block, remove the temporary entries that this turn created outside the ${place}. Never remove the directory that \`TMPDIR\`, \`TEMP\`, or \`TMP\` names, or an entry in it that the coding tool or the runtime created. Put your own scratch files in a subdirectory of it that you create, and remove only that subdirectory. If you cannot create the subdirectory, put the scratch files directly in that directory and remove only those files. The runtime removes the private turn directory that it created. Name in Notes any entry that you cannot remove.${example}`;
};

// Shared clauses of the probe-copy rule. Each clause appears once, and both variants interpolate it.
const PROBE_UNRESOLVED = "report the probe as unresolved in Checks.";
const INSTALLED_BINARY = "call the installed binary directly";
const NO_DEPENDENCY_INSTALL = "dependency install, repair, or update";
const SHARED_PACKAGE_STORE = "the shared package store";

const PROBE_IS_GIT_WORK_TREE =
  "When a probe of another commit needs a copy, the copy is a Git work tree made with `git worktree add` under the turn temporary directory, not an archive extraction, and it never links or junctions a directory of any work tree or checkout (the run work tree, the primary checkout, or another work tree) into it.";

// The install ban covers a copy of the same commit as well as a copy of another commit.
const PROBE_INSTALL_BAN = `Run no ${NO_DEPENDENCY_INSTALL} in any probe copy.`;

const PROBE_REMOVE_WORK_TREE =
  'Remove the probe work tree with `git worktree remove --force "<probe copy>"` before any folder delete.';

// The reviewer keeps the plain copy method of main: `git worktree add` writes to the shared
// worktree registry, which the read-only turn does not change. The ban covers a copy of the current
// commit as well as a copy of another commit.
const PROBE_REVIEWER_NO_LINK =
  "A probe copy of the repository, of the current commit or another commit, never links or junctions a directory of any work tree or checkout (the work tree, the primary checkout, or another work tree) into it.";

const PROBE_LINK_SAFE_REMOVAL =
  'When a probe copy holds a link or junction, remove it without a recursive delete that follows links: `cmd.exe /c rmdir /s /q "<probe copy with backslashes>"` in cmd.exe or PowerShell, `MSYS_NO_PATHCONV=1 cmd.exe /c rmdir /s /q "$(cygpath -w "<probe copy>")"` in Git Bash, or `rm -rf "<probe copy>"` on POSIX.';

const probeCopyText = {
  "work tree": () =>
    `${PROBE_IS_GIT_WORK_TREE} A probe copy with no dependencies of its own runs only commands that need none. ${PROBE_INSTALL_BAN} ${PROBE_REMOVE_WORK_TREE} ${PROBE_LINK_SAFE_REMOVAL}
  - A tool such as \`vp\` installs into ${SHARED_PACKAGE_STORE} when it finds no usable \`node_modules\`. Every work tree that links the store sees that write. Before \`pnpm run\` or \`pnpm exec\` in a probe copy, set \`PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn\` in the environment of that command, or ${INSTALLED_BINARY}. pnpm installs from its dependency check by default.`,
  repository: () =>
    `Run no ${NO_DEPENDENCY_INSTALL} in this turn, and start no command that installs, such as a package manager install, add, update, or repair command, or a test runner that installs when it finds no usable installed dependencies. An install writes to ${SHARED_PACKAGE_STORE} outside the repository and reaches every work tree that links it, and the runtime mutation check does not see those writes. ${PROBE_REVIEWER_NO_LINK} ${PROBE_LINK_SAFE_REMOVAL} The runtime sets the environment of this turn so that the dependency check of a package manager warns and never installs before a run or exec command. In a probe copy, ${INSTALLED_BINARY} instead of a package manager run or exec command, or ${PROBE_UNRESOLVED}`,
};

/**
 * The probe-copy dependency rule of the worker and reviewer prompts. `place` selects the wording
 * that the prompt for that tree carries.
 */
export const probeCopyRule = (place) => probeCopyText[place]();

/** What a pull request body describes. The worker and orchestrator prompts share it. */
export const PR_BODY_SCOPE =
  "The body describes only the committed or published repository state and names no untracked file, local-only change, local probe, or machine-specific path.";

/** The finish gate sentence that the reviewer and orchestrator prompts share. */
export const REQUIRE_CI_GATE_SENTENCE =
  "The --require-ci finish gate re-reads GitHub and enforces the condition.";

/** The sentence that a PR-head compare finish states after its condition. */
export const NO_CHECK_CLAIM =
  "It reads no required-check source and claims no check result, so the finish summary still states in verified what the checks showed.";
