// CLI commands for `agent-loop install`, `agent-loop uninstall`, and
// `agent-loop harness-check` (#139). The installer is interactive when a TTY
// is present; `--harness` and `--yes` make it scriptable, and tests always pass
// `--harness`.
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { readArgValue, readInlineValue, splitInlineFlag } from "../lib/args.mjs";
import { readableErrorText, readProp } from "../lib/error-message.mjs";
import { logError, logInfo, logInfoFull, logWarn, setVerbose } from "../lib/log.mjs";
import { nearestHarness } from "../lib/process-ancestry.mjs";
import { HARNESS_META, HARNESS_ORDER, harnessForCommand, isHarness } from "../lib/harnesses.mjs";
import { detectHarnesses, install, stablePackageRoot, uninstall } from "./installer.mjs";
import { readManifest, resolveHome } from "./manifest.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function parseHarnessList(value) {
  const harnesses = [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  for (const harness of harnesses) {
    if (!isHarness(harness)) {
      throw new Error(`Unknown harness: ${harness}. Choose from ${HARNESS_ORDER.join(", ")}.`);
    }
  }
  return harnesses;
}

function parseFlags(argv) {
  const options = { harnesses: null, yes: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const inline = splitInlineFlag(raw);
    const arg = inline ? inline.flag : raw;
    let inlineUsed = false;
    const readInline = (flag) => {
      if (!inline) {
        return readArgValue(argv, flag, ++i);
      }
      inlineUsed = true;
      return readInlineValue(inline, flag);
    };
    if (arg === "--harness") {
      options.harnesses = parseHarnessList(readInline(arg));
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${raw}`);
    }

    // A flag that read no value is boolean, so an inline value is an error
    // rather than a silently dropped argument.
    if (inline && !inlineUsed) {
      throw new Error(`${arg} does not take a value.`);
    }
  }
  return options;
}

function resolveSelection(token, discovered) {
  if (/^\d+$/.test(token)) {
    const index = Number(token) - 1;
    const harness = discovered[index];
    if (!harness) {
      throw new Error(`No harness at position ${token}.`);
    }
    return harness;
  }
  return parseHarnessList(token)[0];
}

async function selectHarnesses(discovered) {
  const menu = HARNESS_ORDER.map((harness, index) => {
    const marker = discovered.includes(harness) ? " [detected]" : "";
    return `${index + 1}. ${HARNESS_META[harness].label} (${harness})${marker}`;
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        `\nSelect harnesses by number or name, comma-separated.\n${menu.join("\n")}\n` +
          `Selection [${discovered.join(",") || "none"}]: `,
      )
    ).trim();
    if (answer === "") {
      return discovered;
    }
    return [
      ...new Set(
        answer
          .split(",")
          .map((part) => resolveSelection(part.trim(), discovered))
          .filter(Boolean),
      ),
    ];
  } finally {
    rl.close();
  }
}

function printReports(reports, dryRun) {
  if (reports.length === 0) {
    logInfo("Nothing to change.");
    return;
  }
  for (const entry of reports) {
    const prefix = dryRun ? "would " : "";
    const detail = entry.detail ? ` (${entry.detail})` : "";
    if (entry.action === "note") {
      // Notes carry guidance past the 300-character log cap, so print them in
      // full (#200).
      logInfoFull(`${entry.harness}: ${entry.detail}`);
      continue;
    }
    logInfo(`${entry.harness}: ${prefix}${entry.action} ${entry.path}${detail}`);
    if (entry.snippet) {
      console.log(entry.snippet);
    }
  }
}

/**
 * Parses flags, prints `usage` for --help, and applies --verbose. Returns the
 * options, or null when the command already finished: a parse error sets exit
 * code 1, and --help leaves `process.exitCode` unchanged.
 */
function parseCommand(argv, usage) {
  let options;
  try {
    options = parseFlags(argv);
  } catch (err) {
    logError(readableErrorText(err));
    process.exitCode = 1;
    return null;
  }
  if (options.help) {
    console.log(usage.join("\n"));
    return null;
  }
  setVerbose(Boolean(options.verbose));
  return options;
}

export async function runInstallCommand(argv) {
  const options = parseCommand(argv, [
    "Usage: agent-loop install [--harness <list>] [--yes] [--dry-run]",
    "",
    "A value flag also accepts --flag=value, for example --harness=claude,codex.",
    `Harnesses: ${HARNESS_ORDER.join(", ")}`,
    "Without --harness, detected CLIs are preselected in an interactive prompt.",
  ]);
  if (!options) {
    return;
  }

  let harnesses = options.harnesses;
  if (!harnesses) {
    if (options.yes || !process.stdin.isTTY) {
      logError("No --harness given and stdin is not interactive. Pass --harness <list>.");
      process.exitCode = 1;
      return;
    }
    harnesses = await selectHarnesses(await detectHarnesses());
  }
  if (!harnesses.length) {
    logWarn("No harness selected; nothing to do.");
    return;
  }

  let reports;
  try {
    reports = await install({
      harnesses,
      home: resolveHome(),
      // Node resolves the script into the pnpm virtual store, while
      // `process.argv[1]` keeps the path it was called with, which a pnpm 12
      // project bin shim points at the project link.
      packageRoot: stablePackageRoot(PACKAGE_ROOT, process.argv[1]),
      dryRun: options.dryRun,
    });
  } catch (err) {
    const path = readProp(err, "path");
    const text = readableErrorText(err);
    logError(path ? `${path}: ${text}` : text);
    const snippet = readProp(err, "snippet");
    if (snippet) {
      console.log(snippet);
    }
    process.exitCode = 1;
    return;
  }
  printReports(reports, options.dryRun);
}

export async function runUninstallCommand(argv) {
  const options = parseCommand(argv, [
    "Usage: agent-loop uninstall [--harness <list>] [--yes] [--dry-run]",
    "",
    "A value flag also accepts --flag=value, for example --harness=claude,codex.",
    "Without --harness, the harnesses recorded in the install manifest are removed.",
  ]);
  if (!options) {
    return;
  }

  let harnesses = options.harnesses;
  if (!harnesses && !options.yes && process.stdin.isTTY) {
    let manifest;
    try {
      manifest = await readManifest(resolveHome());
    } catch (err) {
      logError(readableErrorText(err));
      process.exitCode = 1;
      return;
    }
    const installed = HARNESS_ORDER.filter((harness) => manifest.harnesses[harness]);
    if (installed.length === 0) {
      logInfo("No harness is installed; nothing to remove.");
      return;
    }
    harnesses = await selectHarnesses(installed);
  }

  let reports;
  try {
    reports = await uninstall({ harnesses, home: resolveHome(), dryRun: options.dryRun });
  } catch (err) {
    logError(readableErrorText(err));
    process.exitCode = 1;
    return;
  }
  printReports(reports, options.dryRun);
  if (reports.some((entry) => entry.action === "failed")) {
    process.exitCode = 1;
  }
}

/**
 * Exit code for a harness mismatch: the named harness is not the nearest
 * ancestor, so another harness owns the shell. Exit 0 means the names match;
 * every other non-zero code means the check could not run, found no harness
 * ancestor, or could not read the process ancestry. The distinct code lets a
 * caller separate a genuine harness refusal from a check that did not decide
 * (#151).
 */
export const HARNESS_MISMATCH_EXIT = 3;

export async function runHarnessCheckCommand(argv, { lookup = nearestHarness } = {}) {
  const requested = argv[0];
  if (!requested) {
    logError("harness-check requires a harness name.");
    process.exitCode = 1;
    return;
  }
  const harness = harnessForCommand(requested) ?? requested;
  if (!isHarness(harness)) {
    logError(`Unknown harness: ${requested}`);
    process.exitCode = 1;
    return;
  }

  let found;
  try {
    found = await lookup();
  } catch (err) {
    logError(`could not read the process table: ${readableErrorText(err)}`);
    process.exitCode = 1;
    return;
  }
  if (found === harness) {
    process.exitCode = 0;
    return;
  }
  if (found === null || found === undefined) {
    logError(
      `no known harness process was found above this shell, so not ${harness}. Not starting a run.`,
    );
    process.exitCode = 1;
    return;
  }
  logError(`nearest harness ancestor is ${found}, not ${harness}. Refusing to start a run.`);
  process.exitCode = HARNESS_MISMATCH_EXIT;
}
