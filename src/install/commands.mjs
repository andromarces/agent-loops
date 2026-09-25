// CLI commands for `agent-loop install`, `agent-loop uninstall`, and
// `agent-loop harness-check` (#139). The installer is interactive when a TTY
// is present; `--harness` and `--yes` make it scriptable, and tests always pass
// `--harness`.
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { logError, logInfo, logWarn, setVerbose } from "../lib/log.mjs";
import { nearestHarness } from "../lib/process-ancestry.mjs";
import { HARNESS_META, HARNESS_ORDER, isHarness } from "./harnesses.mjs";
import { detectHarnesses, install, uninstall } from "./installer.mjs";
import { readManifest, resolveHome } from "./manifest.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readValue(argv, flag, index) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

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
    const arg = argv[i];
    if (arg === "--harness") {
      options.harnesses = parseHarnessList(readValue(argv, arg, ++i));
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
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
      logInfo(`${entry.harness}: ${entry.detail}`);
      continue;
    }
    logInfo(`${entry.harness}: ${prefix}${entry.action} ${entry.path}${detail}`);
    if (entry.snippet) {
      console.log(entry.snippet);
    }
  }
}

export async function runInstallCommand(argv) {
  let options;
  try {
    options = parseFlags(argv);
  } catch (err) {
    logError(err.message);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(
      [
        "Usage: agent-loop install [--harness <list>] [--yes] [--dry-run]",
        "",
        `Harnesses: ${HARNESS_ORDER.join(", ")}`,
        "Without --harness, detected CLIs are preselected in an interactive prompt.",
      ].join("\n"),
    );
    return;
  }
  setVerbose(Boolean(options.verbose));

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
      packageRoot: PACKAGE_ROOT,
      dryRun: options.dryRun,
    });
  } catch (err) {
    logError(err.path ? `${err.path}: ${err.message}` : err.message);
    if (err.snippet) {
      console.log(err.snippet);
    }
    process.exitCode = 1;
    return;
  }
  printReports(reports, options.dryRun);
}

export async function runUninstallCommand(argv) {
  let options;
  try {
    options = parseFlags(argv);
  } catch (err) {
    logError(err.message);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(
      [
        "Usage: agent-loop uninstall [--harness <list>] [--yes] [--dry-run]",
        "",
        "Without --harness, the harnesses recorded in the install manifest are removed.",
      ].join("\n"),
    );
    return;
  }
  setVerbose(Boolean(options.verbose));

  let harnesses = options.harnesses;
  if (!harnesses && !options.yes && process.stdin.isTTY) {
    let manifest;
    try {
      manifest = await readManifest(resolveHome());
    } catch (err) {
      logError(err.message);
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
    logError(err.message);
    process.exitCode = 1;
    return;
  }
  printReports(reports, options.dryRun);
}

const HARNESS_ALIASES = new Map([["agy", "antigravity"]]);

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
  const harness = HARNESS_ALIASES.get(requested) ?? requested;
  if (!isHarness(harness)) {
    logError(`Unknown harness: ${requested}`);
    process.exitCode = 1;
    return;
  }

  let found;
  try {
    found = await lookup();
  } catch (err) {
    logError(`could not read the process table: ${err.message}`);
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
