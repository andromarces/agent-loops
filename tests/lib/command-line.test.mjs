import { expect, test } from "vite-plus/test";
import { holdsSession, splitWindowsArguments } from "../../src/lib/command-line.mjs";

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
test("holdsSession on Windows counts a session flag followed by the id", () => {
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
    expect(holdsSession(command, ID, "win32"), command).toBe(true);
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
    expect(holdsSession(command, ID, "win32"), command).toBe(false);
  }
});

// Usefulness: verifies a bare id argument is not a holder, whatever the program, so an unrelated program that carries the id, or a data argument named claude, does not block a run. This narrows the earlier bare-id refusal of ADR 0031 by maintainer decision (#673).
test("holdsSession ignores a bare id argument and an unrelated program", () => {
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
    expect(holdsSession(command, ID, platform), command).toBe(false);
  }
});

// Usefulness: verifies a POSIX holder is found from the space-joined text of ps, where a quote or an apostrophe inside an earlier argument, or a space in a script path, must not hide a later flag and id (#673).
test("holdsSession on POSIX counts a session flag followed by the id and splits on white space only", () => {
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
    expect(holdsSession(command, ID, "linux"), command).toBe(true);
  }
  for (const command of [
    `claude -p --resume ${ID}-copy`,
    `claude -p --resume x${ID}`,
    `claude -p --session-id-file=${ID}`,
    `claude -p --resume"${ID}"`,
    `claude -p "--resume=${ID}"`,
    `claude -p --resume --verbose ${ID}`,
  ]) {
    expect(holdsSession(command, ID, "linux"), command).toBe(false);
  }
});
