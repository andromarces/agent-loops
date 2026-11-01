// CLI commands for `agent-loop install`, `agent-loop uninstall`, and
// `agent-loop harness-check` (#139). The installer is interactive when a TTY
// is present; `--harness` and `--yes` make it scriptable, and tests always pass
// `--harness`.
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { walkFlags } from "../lib/args.mjs";
import { readableErrorText, readProp } from "../lib/error-message.mjs";
import { logError, logInfo, logInfoFull, logWarn, setVerbose } from "../lib/log.mjs";
import { nearestHarness } from "../lib/process-ancestry.mjs";
import { HARNESS_META, HARNESS_ORDER, harnessForCommand, isHarness } from "../lib/harnesses.mjs";
import { detectHarnesses } from "./detect-harnesses.mjs";
import { askHarnessCheckboxes, harnessCheckboxItems } from "./harness-prompt.mjs";
import { install, uninstall } from "./installer.mjs";
import { stablePackageRoot } from "./stable-root.mjs";
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
  walkFlags(argv, 0, (arg, readInline) => {
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
      return false;
    }
    return true;
  });
  return options;
}

// A number resolves against the menu positions that selectHarnesses prints,
// not against the preselected list.
function resolveSelection(token) {
  if (/^\d+$/.test(token)) {
    const harness = HARNESS_ORDER[Number(token) - 1];
    if (!harness) {
      throw new Error(`No harness at position ${token}.`);
    }
    return harness;
  }
  return parseHarnessList(token)[0];
}

async function askSelection(discovered, { input = process.stdin, output = process.stdout } = {}) {
  const menu = HARNESS_ORDER.map((harness, index) => {
    const marker = discovered.includes(harness) ? " [detected]" : "";
    return `${index + 1}. ${HARNESS_META[harness].label} (${harness})${marker}`;
  });
  const rl = createInterface({ input, output });
  try {
    return (
      await rl.question(
        `\nSelect harnesses by number or name, comma-separated.\n${menu.join("\n")}\n` +
          `Selection [${discovered.join(",") || "none"}]: `,
      )
    ).trim();
  } finally {
    rl.close();
  }
}

/**
 * Runs the checkbox list, and the current numbered prompt when the terminal
 * cannot host it. Returns the selection, or null after a bad answer (exit code
 * 1) or a cancelled prompt. Only answer validation is caught. A prompt failure
 * propagates.
 */
async function selectHarnesses(names, checked, io, { markDetected = false } = {}) {
  const asked = await askHarnessCheckboxes({
    items: harnessCheckboxItems({ harnesses: names, checked, markDetected }),
    ...io,
  });
  if (asked.supported) {
    if (!asked.canceled) {
      return asked.selected;
    }
    process.exitCode = asked.reason === "sigint" ? 130 : 1;
    return null;
  }
  const answer = await askSelection(checked, io);
  if (answer === "") {
    return checked;
  }
  try {
    return [
      ...new Set(
        answer
          .split(",")
          .map((part) => resolveSelection(part.trim()))
          .filter(Boolean),
      ),
    ];
  } catch (err) {
    logError(readableErrorText(err));
    process.exitCode = 1;
    return null;
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

function commandStreams(io = {}) {
  return {
    input: io.input ?? process.stdin,
    output: io.output ?? process.stdout,
    env: io.env ?? process.env,
  };
}

export async function runInstallCommand(argv, io = {}) {
  const options = parseCommand(argv, [
    "Usage: agent-loop install [--harness <list>] [--yes] [--dry-run] [--verbose]",
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
    const streams = commandStreams(io);
    if (options.yes || !streams.input.isTTY) {
      logError("No --harness given and stdin is not interactive. Pass --harness <list>.");
      process.exitCode = 1;
      return;
    }
    const discovered = await detectHarnesses();
    harnesses = await selectHarnesses(HARNESS_ORDER, discovered, streams, { markDetected: true });
    if (!harnesses) {
      return;
    }
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

export async function runUninstallCommand(argv, io = {}) {
  const options = parseCommand(argv, [
    "Usage: agent-loop uninstall [--harness <list>] [--yes] [--dry-run] [--verbose]",
    "",
    "A value flag also accepts --flag=value, for example --harness=claude,codex.",
    "Without --harness, the harnesses recorded in the install manifest are removed.",
  ]);
  if (!options) {
    return;
  }

  let harnesses = options.harnesses;
  const streams = commandStreams(io);
  if (!harnesses && !options.yes && streams.input.isTTY) {
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
    harnesses = await selectHarnesses(installed, installed, streams);
    if (!harnesses) {
      return;
    }
  }

  if (harnesses && harnesses.length === 0) {
    logWarn("No harness selected; nothing to do.");
    return;
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

export async function runHarnessCheckCommand(argv, { lookup = nearestHarness, signal } = {}) {
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
    found = await lookup({ signal });
  } catch (err) {
    if (readProp(err, "isCanceled")) {
      logError("harness-check was canceled.");
      process.exitCode = 130;
      return;
    }
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
