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

const EXECA_MARKERS = ["shortMessage", "exitCode", "signal", "code", "command", "escapedCommand"];

// A throwing trap counts as present, so a hostile value takes the fixed report.
function isExecaFailure(error) {
  return EXECA_MARKERS.some((key) => {
    try {
      return key in error || error[key] !== undefined;
    } catch {
      return true;
    }
  });
}

// Only a number or a string prints, because any other value can hold the command arguments.
function printable(value) {
  return typeof value === "number" || typeof value === "string"
    ? redactedText(value)
    : "[unprintable]";
}

/**
 * Prints the failure report from an allowlist, so no unlisted content reaches it (ADR 0017).
 * An execa error carries the whole command line, with the task arguments and their shell quoting,
 * in `message`, `shortMessage`, `command`, and `escapedCommand`. A value with any execa field
 * prints a fixed description plus the exit code, the signal, and the error code, each only when it
 * is a number or a string. Any other object prints its `message` only when that is a string.
 * A thrown primitive prints its text. Nothing here throws, and the text goes through the shared
 * redaction.
 */
export function reportFailure(error) {
  let message;
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    if (isExecaFailure(error)) {
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
      const text = readProp(error, "message");
      message = typeof text === "string" ? redactedText(text) : UNSERIALIZABLE_MESSAGE;
    }
  } else {
    message = redactedText(error);
  }
  console.error(`agent-loop-copilot: ${redactedText(message.split("\n", 1)[0])}`);
  process.exitCode = 1;
}

if (isEntryPoint(import.meta.filename)) {
  main().catch(reportFailure);
}
