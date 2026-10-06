#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { isEntryPoint } from "../lib/entrypoint.mjs";
import { readProp, redactedText, UNSERIALIZABLE_MESSAGE } from "../lib/error-message.mjs";

// Resolve the shipped instructions relative to this file, so the launcher works
// from any directory, not only from a clone of this repository. The file lives
// outside the session workspace, so the invocation grants Copilot access to its
// directory with --add-dir.
const INSTRUCTIONS_DIR = fileURLToPath(new URL("../../docs", import.meta.url));
const INSTRUCTIONS_PATH = join(INSTRUCTIONS_DIR, "orchestrator-instructions.md");

// The prompt is one line. execa rejects CR or LF in an argument on Windows when
// it spawns a batch shim through cmd.exe, and npm installs the copilot CLI as a
// .cmd shim on Windows.
const INSTRUCTIONS = (sessionId, task) =>
  [
    `Read \`${INSTRUCTIONS_PATH}\` and follow it for this request.`,
    "The task and role settings are:",
    task,
    `This Copilot CLI session id is \`${sessionId}\`. Pass it as \`--parent-session\` on the init dispatch call.`,
  ]
    .join(" ")
    .replace(/[\r\n]+/g, " ");

export function buildCopilotInvocation(task, sessionId) {
  const normalizedTask = String(task ?? "").trim();
  if (!normalizedTask) {
    throw new Error("A task and role settings prompt is required.");
  }
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error("A Copilot CLI session id is required.");
  }
  return {
    command: "copilot",
    args: [
      "--session-id",
      sessionId,
      "--add-dir",
      INSTRUCTIONS_DIR,
      "--interactive",
      INSTRUCTIONS(sessionId, normalizedTask),
    ],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const task = argv.join(" ").trim();
  const invocation = buildCopilotInvocation(task, randomUUID());
  await execa(invocation.command, invocation.args, { stdio: "inherit" });
}

// Only a number or a string prints, because an object can hold the command arguments (ADR 0017).
function printable(value) {
  return typeof value === "number" || typeof value === "string"
    ? redactedText(value)
    : "[unprintable]";
}

/**
 * Prints the failure report. An execa error carries the whole command line, with the task
 * arguments and their shell quoting, in `message` and `shortMessage`, so the report is built from
 * the exit code, the signal, and the error code only. Any other error prints its own message. The
 * text goes through the shared redaction either way (ADR 0017).
 */
export function reportFailure(error) {
  let message;
  let isExeca;
  try {
    isExeca = typeof error?.shortMessage === "string";
  } catch {
    // An unreadable `shortMessage` marks an execa error, so the report never falls back to `message`.
    isExeca = true;
  }
  if (isExeca) {
    const exitCode = readProp(error, "exitCode");
    const signal = readProp(error, "signal");
    const code = readProp(error, "code");
    const causes = [
      exitCode === undefined ? null : `exit code ${printable(exitCode)}`,
      signal ? `signal ${printable(signal)}` : null,
      code ? `error code ${printable(code)}` : null,
    ].filter(Boolean);
    message = `copilot failed${causes.length > 0 ? ` (${causes.join(", ")})` : ""}`;
  } else {
    const text = readProp(error, "message") ?? error;
    // An object without a string message never serializes, because its content can hold argv.
    message = (
      typeof text === "string" || typeof text !== "object" || text === null
        ? redactedText(text)
        : UNSERIALIZABLE_MESSAGE
    ).split("\n", 1)[0];
  }
  console.error(`agent-loop-copilot: ${redactedText(message)}`);
  process.exitCode = 1;
}

if (isEntryPoint(import.meta.filename)) {
  main().catch(reportFailure);
}
