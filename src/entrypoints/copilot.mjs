#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { isEntryPoint } from "../lib/entrypoint.mjs";

// Resolve the shipped instructions relative to this file, so the launcher works
// from any directory, not only from a clone of this repository. The file lives
// outside the session workspace, so the invocation grants Copilot access to its
// directory with --add-dir.
const INSTRUCTIONS_DIR = fileURLToPath(new URL("../../docs", import.meta.url));
const INSTRUCTIONS_PATH = join(INSTRUCTIONS_DIR, "orchestrator-instructions.md");

const INSTRUCTIONS = (sessionId, task) =>
  [
    `Read \`${INSTRUCTIONS_PATH}\` and follow it for this request.`,
    "The task and role settings are:",
    task,
    `This Copilot CLI session id is \`${sessionId}\`. Pass it as \`--parent-session\` on the init dispatch call.`,
  ].join("\n\n");

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

if (isEntryPoint(import.meta.filename)) {
  main().catch((error) => {
    const message = String(error?.shortMessage ?? error?.message ?? error).split("\n", 1)[0];
    console.error(`agent-loop-copilot: ${message}`);
    process.exitCode = 1;
  });
}
