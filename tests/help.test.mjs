import { expect, test, vi } from "vite-plus/test";
import { main, parseArgs } from "../src/cli.mjs";
import { printHelp } from "../src/help.mjs";
import { setLogsToStderr } from "../src/lib/log.mjs";
import { parseRoleArgs } from "../src/role/index.mjs";

function render(print) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    print();
    return log.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
}

async function renderRoleHelp() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await main(["role", "--help"]);
    return log.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    log.mockRestore();
    setLogsToStderr(false);
  }
}

// The flag spec of a help entry, before its description column.
function specFlags(line) {
  if (!/^ {2}(?:--[a-z]|-[a-zA-Z],)/.test(line)) return [];
  const spec = line.trimEnd().slice(2).split(/ {2,}/)[0];
  return spec.match(/--[a-z0-9-]+\*?/g) ?? [];
}

function sectionFlags(help, header) {
  const lines = help.split("\n");
  const start = lines.indexOf(`${header}:`);
  const flags = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    if (!lines[i].startsWith("  ")) break;
    flags.push(...specFlags(lines[i]));
  }
  return flags;
}

// `--worker*` stands for every listed flag with that prefix.
function expand(flags, known) {
  return flags.flatMap((flag) =>
    flag.endsWith("*")
      ? [...known].filter(
          (candidate) => !candidate.endsWith("*") && candidate.startsWith(flag.slice(0, -1)),
        )
      : [flag],
  );
}

function summaryBlock(help) {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => /^ {2}agent-loop role {2,}\S/.test(line));
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length && /^ {32}\S/.test(lines[i]); i++) {
    block.push(lines[i]);
  }
  return block.join(" ");
}

function roleSummaryBlock(roleHelp) {
  const lines = roleHelp.split("\n");
  let i = lines.findIndex((line) => line.startsWith("Usage: agent-loop role [")) + 1;
  while (lines[i] === "") i++;
  const block = [];
  while (i < lines.length && lines[i] !== "") block.push(lines[i++]);
  return block.join(" ");
}

// Usefulness: every flag that the help lists parses in its mode, so no reader meets Unknown argument (#1641).
test("each flag in the rendered help is accepted by its mode parser", async () => {
  const headless = render(printHelp);
  const roleHelp = await renderRoleHelp();
  const roleFlagTokens = sectionFlags(headless, "Role flags");
  const optionFlagTokens = sectionFlags(headless, "Options");
  const namedFlags = roleHelp.match(/--[a-z0-9-]+/g) ?? [];
  const known = new Set([...roleFlagTokens, ...optionFlagTokens, ...namedFlags]);

  expect(roleFlagTokens.length).toBeGreaterThan(0);
  expect(optionFlagTokens.length).toBeGreaterThan(0);

  for (const flag of new Set(expand(roleFlagTokens, known))) {
    expect(() => parseRoleArgs([flag])).not.toThrow(`Unknown argument: ${flag}`);
  }
  for (const flag of new Set(expand(optionFlagTokens, known))) {
    // --help and --version print and exit instead of parsing into an option.
    if (flag === "--help" || flag === "--version") continue;
    expect(() => parseArgs([flag])).not.toThrow(`Unknown argument: ${flag}`);
  }
  for (const flag of new Set(expand(namedFlags, known))) {
    expect(() => parseRoleArgs([flag])).not.toThrow(`Unknown argument: ${flag}`);
  }
});

// Usefulness: both role summaries name every dispatched operation, so no supported operation is hidden (#1641).
test("both role summaries name every dispatched operation", async () => {
  const headless = render(printHelp);
  const roleHelp = await renderRoleHelp();
  const usage = roleHelp.split("\n").find((line) => line.startsWith("Usage: agent-loop role ["));
  const operations = usage.slice(usage.indexOf("[") + 1, usage.indexOf("]")).split("|");
  expect(operations.length).toBeGreaterThan(1);

  const headlessSummary = summaryBlock(headless);
  const roleSummary = roleSummaryBlock(roleHelp);
  for (const operation of operations) {
    expect(headlessSummary).toContain(operation);
    expect(roleSummary).toContain(operation);
  }
});

// Usefulness: the batch help states the three item kinds and how a mixed request becomes items.
test("the batch help names item kinds and the mixed-request path", () => {
  const help = render(printHelp);
  expect(help).toContain("--items-file <path>");
  expect(help).toContain("issue, pr, or task");
  expect(help).toContain("mixed request");
});

// Usefulness: help names the install, uninstall, test-slot, and role flags that their parsers accept (#1783).
test("help names the supported install, uninstall, test-slot, and role flags", () => {
  const help = render(printHelp);
  const installBlock = help.slice(
    help.indexOf("agent-loop install"),
    help.indexOf("agent-loop test-slot"),
  );
  expect(installBlock.match(/-y, --dry-run, and --verbose/g)).toHaveLength(2);
  expect(help).toContain("-- <executable> <arg> [<arg>...]");
  expect(sectionFlags(help, "Role flags")).toContain("--verbose");
});
