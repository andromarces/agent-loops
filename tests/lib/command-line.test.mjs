import { expect, test } from "vite-plus/test";
import { holdsSession, splitWindowsArguments } from "../../src/lib/command-line.mjs";

// Expected tokens come from the two native Windows parsers, run on Windows 11 Pro 10.0.26220 with
// Node v26.8.1 (#673). The `crt` column is `process.argv.slice(2)` of a child that node started with
// the raw command line `<node> child.mjs <line>`: the argument parser of the C runtime. The
// `shell32` column is `CommandLineToArgvW("prog <line>")` called through PowerShell 7.6.6, minus the
// program name. The two differ only for a doubled quote inside a quoted section: the CRT keeps the
// quoted section open after the literal quote, and CommandLineToArgvW ends it.
// Each row is [command line, crt tokens, shell32 tokens].
const NATIVE_TOKENS = [
  ['a ""b"" c', ["a", "b", "c"], ["a", "b", "c"]],
  ['a "" b', ["a", "", "b"], ["a", "", "b"]],
  ['a "b""c" d', ["a", 'b"c', "d"], ["a", 'b"c d']],
  ['a "b ""c d"" e" f', ["a", 'b "c d" e', "f"], ["a", 'b "c', "d", "e f"]],
  ['a """b""" c', ["a", '"b"', "c"], ["a", '"b"', "c"]],
  ['a "b""" c', ["a", 'b"', "c"], ["a", 'b" c']],
  ['a """" c', ["a", '"', "c"], ["a", '" c']],
  ['a """b c', ["a", '"b c'], ["a", '"b', "c"]],
  ['a b""c d', ["a", "bc", "d"], ["a", "bc", "d"]],
  ['a "b c"" d', ["a", 'b c" d'], ["a", 'b c"', "d"]],
  ['a \\"b c', ["a", '"b', "c"], ["a", '"b', "c"]],
  ['a \\\\"b c" d', ["a", "\\b c", "d"], ["a", "\\b c", "d"]],
  ['a \\\\\\"b c', ["a", '\\"b', "c"], ["a", '\\"b', "c"]],
  ['a "b\\\\" c', ["a", "b\\", "c"], ["a", "b\\", "c"]],
  ['a "b\\\\\\" c" d', ["a", 'b\\" c', "d"], ["a", 'b\\" c', "d"]],
  ["a C:\\x\\ y", ["a", "C:\\x\\", "y"], ["a", "C:\\x\\", "y"]],
  ['a "C:\\x y\\\\" z', ["a", "C:\\x y\\", "z"], ["a", "C:\\x y\\", "z"]],
  ['a "--resume" id', ["a", "--resume", "id"], ["a", "--resume", "id"]],
  ['a "--session-id=id" b', ["a", "--session-id=id", "b"], ["a", "--session-id=id", "b"]],
  ['a --resume="id" b', ["a", "--resume=id", "b"], ["a", "--resume=id", "b"]],
  ['a --resume ""id"" b', ["a", "--resume", "id", "b"], ["a", "--resume", "id", "b"]],
  ['a ""--resume"" id', ["a", "--resume", "id"], ["a", "--resume", "id"]],
  ['a "b', ["a", "b"], ["a", "b"]],
  ["a\tb  c", ["a", "b", "c"], ["a", "b", "c"]],
  ['a "" "" c', ["a", "", "", "c"], ["a", "", "", "c"]],
  ['a """""" c', ["a", '""', "c"], ["a", '""', "c"]],
  ['a "b"""', ["a", 'b"'], ["a", 'b"']],
  ['a "b"c d', ["a", "bc", "d"], ["a", "bc", "d"]],
  ['a "b c"d" e" f', ["a", "b cd e", "f"], ["a", "b cd e", "f"]],
  ["a b\\c d\\ e", ["a", "b\\c", "d\\", "e"], ["a", "b\\c", "d\\", "e"]],
  ['a \\\\\\\\"b c" d', ["a", "\\\\b c", "d"], ["a", "\\\\b c", "d"]],
  ['a "b""c""d" e', ["a", 'b"c"d', "e"], ["a", 'b"cd e']],
  ['a "b"" c" d', ["a", 'b" c', "d"], ["a", 'b"', "c d"]],
  ['a ""', ["a", ""], ["a", ""]],
  ['a """', ["a", '"'], ["a", '"']],
  ['a "x ""', ["a", 'x "'], ["a", 'x "']],
  ["a \\", ["a", "\\"], ["a", "\\"]],
  ['a "\\" b', ["a", '" b'], ["a", '" b']],
  ['a "b\tc" d', ["a", "b\tc", "d"], ["a", "b\tc", "d"]],
  ['a ""b c', ["a", "b", "c"], ["a", "b", "c"]],
  ['a b"" "c d"', ["a", "b", "c d"], ["a", "b", "c d"]],
];

// Usefulness: verifies the Windows tokenizer equals the CRT parser on every probed command line, including doubled quotes and backslash runs, so a quoted holder is read as the process reads it.
test("splitWindowsArguments matches the CRT parser on the probed command lines", () => {
  for (const [line, crt] of NATIVE_TOKENS) {
    expect(splitWindowsArguments(line, "crt"), line).toEqual(crt);
  }
});

// Usefulness: verifies the Windows tokenizer equals CommandLineToArgvW on every probed command line, so both parsers that a holder can be started under are covered.
test("splitWindowsArguments matches CommandLineToArgvW on the probed command lines", () => {
  for (const [line, , shell32] of NATIVE_TOKENS) {
    expect(splitWindowsArguments(line, "shell32"), line).toEqual(shell32);
  }
});

const ID = "11111111-2222-4333-8444-555555555555";

// Usefulness: verifies a Windows holder is found for a flag value, a quoted flag, a doubled-quote form, or a bare id, and never for a substring of an argument (#673).
test("holdsSession on Windows counts an argument equal to the id or a session flag with the id", () => {
  for (const command of [
    `claude -p --resume ${ID} --output-format json`,
    `claude -p --session-id=${ID}`,
    `claude -p -r=${ID}`,
    `claude -p "--resume" ${ID}`,
    `claude -p "--session-id=${ID}"`,
    `claude -p --resume="${ID}"`,
    `claude -p --resume ""${ID}""`,
    `claude -p ""--resume"" ${ID}`,
    `claude ${ID}`,
    `claude -p --resume ${ID.toUpperCase()}`,
    String.raw`"C:\Program Files\claude.exe" -p --resume "${ID}"`,
  ]) {
    expect(holdsSession(command, ID, "win32"), command).toBe(true);
  }
  for (const command of [
    `claude -p --resume ${ID}-copy`,
    `claude -p --resume x${ID}`,
    `claude -p --session-id-file=${ID}`,
    `claude -p --model=${ID}`,
    String.raw`node app.js --log "C:\logs\${ID}.log"`,
    String.raw`node app.js --log C:\logs\${ID}.log`,
    String.raw`claude -p --resume\"${ID}\"`,
    // A doubled quote inside a quoted section is a literal quote, so the id is not a whole argument.
    `claude -p "x ""${ID}"" y"`,
  ]) {
    expect(holdsSession(command, ID, "win32"), command).toBe(false);
  }
});

// Usefulness: verifies a POSIX holder is found from the space-joined text of ps, where a quote or an apostrophe inside an earlier argument must not hide a later id (#673).
test("holdsSession on POSIX splits on white space only", () => {
  for (const command of [
    `claude -p --resume ${ID} --output-format json`,
    `claude -p --session-id=${ID}`,
    `claude -p -r=${ID}`,
    `claude ${ID}`,
    `node test ${ID}`,
    `claude -p --append-system-prompt it's a "test --resume ${ID}`,
    `claude -p --append-system-prompt "don't --resume ${ID}`,
  ]) {
    expect(holdsSession(command, ID, "linux"), command).toBe(true);
  }
  for (const command of [
    `tail -f /home/u/.claude/projects/p/${ID}.jsonl`,
    `claude -p --resume ${ID}-copy`,
    `claude -p --resume x${ID}`,
    `claude -p --session-id-file=${ID}`,
    `claude -p --resume"${ID}"`,
    `claude -p "--resume=${ID}"`,
  ]) {
    expect(holdsSession(command, ID, "linux"), command).toBe(false);
  }
});
