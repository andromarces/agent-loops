#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { execa } from "execa";

const SUPPORTED = new Set(["claude", "codex", "agy", "antigravity", "opencode", "copilot"]);

const COMPLETE_MARKER = "REVIEW_COMPLETE";

function parseArgs(argv) {
  const options = {
    reviewer: null,
    worker: null,
    cwd: process.cwd(),
    task: null,
    maxReviews: 10,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--reviewer":
        options.reviewer = argv[++i];
        break;

      case "--worker":
        options.worker = argv[++i];
        break;

      case "--cwd":
        options.cwd = resolve(argv[++i]);
        break;

      case "--task":
        options.task = argv[++i];
        break;

      case "--max-reviews":
        options.maxReviews = Number(argv[++i]);
        break;

      case "--help":
      case "-h":
        printHelp();
        process.exit(0);

      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!SUPPORTED.has(options.reviewer)) {
    throw new Error(`Unsupported reviewer: ${options.reviewer}`);
  }

  if (!SUPPORTED.has(options.worker)) {
    throw new Error(`Unsupported worker: ${options.worker}`);
  }

  if (options.task === null || options.task === undefined || String(options.task).trim() === "") {
    throw new Error(
      'Missing required --task. Provide the worker task, for example --task "Implement the change."',
    );
  }

  if (!Number.isInteger(options.maxReviews) || options.maxReviews < 1) {
    throw new Error("--max-reviews must be a positive integer.");
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:

  agent-loop \\
    --reviewer codex \\
    --worker claude \\
    --task "Implement the change."

The worker acts first from --task. The reviewer verifies each worker result.
When the reviewer returns REVIEW_COMPLETE, the worker returns a final summary.

Options:

  --reviewer <agent>       Agent that reviews the repository. Required.
  --worker <agent>         Agent that implements the review findings. Required.
  --cwd <directory>        Working directory for the agents. Defaults to the directory where the command ran. Changes the working directory only; does not activate that directory's environment.
  --task <text>            Worker task. Required.
  --max-reviews <count>    Maximum review passes. Defaults to 10.
  -h, --help               Show help.

Environment:

  The loop spawns each agent CLI directly, without a shell. Agents inherit the environment of the process that launched the loop. Start the loop from a shell where direnv or a similar tool already exported the required variables. No default shell and no automatic environment loader are provided by design.

Agents:

  claude
  codex
  agy
  antigravity
  opencode
  copilot
`);
}

function normalizeAgent(kind) {
  return kind === "antigravity" ? "agy" : kind;
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${description}:\n${text.slice(0, 2000)}`);
  }
}

function parseJsonLines(text) {
  const events = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }

  return events;
}

async function exec(command, args, cwd, input) {
  const result = await execa(command, args, {
    cwd,
    reject: false,
    input,
    stdin: input === undefined ? "ignore" : undefined,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `${command} exited with code ${result.exitCode}.`,
        result.stderr?.trim(),
        result.stdout?.trim(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function runClaude(state, prompt, cwd) {
  const args = ["-p"];

  if (state.sessionId) {
    args.push("--resume", state.sessionId);
  }

  args.push(prompt, "--output-format", "json");

  const { stdout } = await exec("claude", args, cwd);
  const parsed = parseJson(stdout, "Claude Code");

  let sessionId;
  let response;

  if (Array.isArray(parsed)) {
    sessionId = parsed.map((event) => event?.session_id).find(Boolean);
    response = parsed.find((event) => event?.type === "result")?.result;
  } else {
    sessionId = parsed.session_id;
    response = parsed.result;
  }

  if (!sessionId) {
    throw new Error("Claude Code did not return a session_id.");
  }

  state.sessionId = sessionId;

  return String(response ?? "").trim();
}

async function runCodex(state, prompt, cwd) {
  const args = state.sessionId
    ? ["exec", "resume", state.sessionId, "--json", "-"]
    : ["exec", "--json"];

  const { stdout } = await exec("codex", args, cwd, prompt);
  const events = parseJsonLines(stdout);

  const started = events.find((event) => event.type === "thread.started");

  const returnedId = started?.thread_id;

  if (!returnedId) {
    throw new Error("Codex did not return a thread ID.");
  }

  if (state.sessionId && returnedId !== state.sessionId) {
    throw new Error(
      [
        "Codex did not resume the expected thread.",
        `Expected: ${state.sessionId}`,
        `Received: ${returnedId}`,
      ].join("\n"),
    );
  }

  state.sessionId = returnedId;

  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text)
    .filter(Boolean);

  if (messages.length === 0) {
    throw new Error("Codex did not return an agent message.");
  }

  return String(messages.at(-1)).trim();
}

async function runAgy(state, prompt, cwd) {
  const args = ["-p", prompt];

  if (state.sessionId) {
    args.push("--conversation", state.sessionId);
  }

  args.push("--output-format", "json");

  const { stdout } = await exec("agy", args, cwd);
  const result = parseJson(stdout, "Antigravity CLI");

  if (!result.conversation_id) {
    throw new Error("Antigravity did not return a conversation_id.");
  }

  state.sessionId = result.conversation_id;

  return String(result.response ?? "").trim();
}

async function runOpenCode(state, prompt, cwd, command) {
  const args = ["run", "--format", "json"];

  if (state.sessionId) {
    args.push("--session", state.sessionId);
  }

  const { stdout } = await exec(command, args, cwd, prompt);
  const events = parseJsonLines(stdout);

  const sessionId = events.map((event) => event.sessionID).find(Boolean);

  if (!sessionId) {
    throw new Error(`${command} did not return a session ID.`);
  }

  if (state.sessionId && state.sessionId !== sessionId) {
    throw new Error(
      [
        `${command} did not resume the expected session.`,
        `Expected: ${state.sessionId}`,
        `Received: ${sessionId}`,
      ].join("\n"),
    );
  }

  state.sessionId = sessionId;

  const text = events
    .filter((event) => event.type === "text" && typeof event.part?.text === "string")
    .map((event) => event.part.text)
    .join("");

  if (!text.trim()) {
    throw new Error(`${command} did not return response text.`);
  }

  return text.trim();
}

async function runCopilot(state, prompt, cwd) {
  if (!state.sessionId) {
    state.sessionId = randomUUID();
  }

  const args = ["--session-id", state.sessionId, "-s", "--no-ask-user"];

  const { stdout } = await exec("copilot", args, cwd, prompt);

  if (!stdout.trim()) {
    throw new Error("Copilot did not return response text.");
  }

  return stdout.trim();
}

async function runAgent(state, prompt, cwd) {
  switch (state.kind) {
    case "claude":
      return runClaude(state, prompt, cwd);

    case "codex":
      return runCodex(state, prompt, cwd);

    case "agy":
      return runAgy(state, prompt, cwd);

    case "opencode":
      return runOpenCode(state, prompt, cwd, "opencode");

    case "copilot":
      return runCopilot(state, prompt, cwd);

    default:
      throw new Error(`Unsupported agent: ${state.kind}`);
  }
}

function reviewComplete(text) {
  return text.trim() === COMPLETE_MARKER;
}

function initialWorkerPrompt(task) {
  return `
You are the implementation agent in an automated review loop.

Complete the task below. Inspect the actual repository state before you make changes. Run relevant tests, checks, or validation. Do not merely explain what must change.

After this turn, a reviewer will inspect your work. Each later message you receive starts with the line "From the Reviewer:" followed by either actionable findings or the single line REVIEW_COMPLETE.

When you receive findings, address every actionable finding, then report what you changed, what you verified, and any finding you did not address and why.

When you receive exactly this two-line message:
From the Reviewer:
REVIEW_COMPLETE

Do not change any files. Return a final summary report that covers the entire task, not only the last turn, with these sections:
- Changed: what changed across the whole loop
- Verified: what verification ran and its results
- Deferred: items intentionally postponed, with the reason
- Not done: items not completed, with the reason
- Open: unresolved questions or risks for the user
If a section has no items, state that explicitly.

Task:
${task}
`.trim();
}

function workerFollowUpPrompt(findings) {
  return `
From the Reviewer:
${findings}
`.trim();
}

function initialReviewPrompt(task, workerResponse) {
  return `
Do not implement, fix, edit, or change anything yet. Review, assess, and verify only. Live probes and queries if needed are authorized. If there are any actionable blocking and non-blocking findings, only return with all the actionable blocking and non-blocking findings. If there are no actionable blocking and non-blocking findings, return REVIEW_COMPLETE.

Instruction for the Worker:
${task}

From the Worker:
${workerResponse}
`.trim();
}

function followUpReviewPrompt(workerResult) {
  return `
Do not implement, fix, edit, or change anything yet. Review, assess, and verify only. Live probes and queries if needed are authorized.

From the Worker:
${workerResult}
`.trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const reviewer = {
    kind: normalizeAgent(options.reviewer),
    sessionId: null,
  };

  const worker = {
    kind: normalizeAgent(options.worker),
    sessionId: null,
  };

  let workerResult = await runAgent(worker, initialWorkerPrompt(options.task), options.cwd);
  console.log("\n===== IMPLEMENTATION 1 =====\n");
  console.log(workerResult);

  for (let reviewNumber = 1; ; reviewNumber++) {
    const review =
      reviewNumber === 1
        ? await runAgent(reviewer, initialReviewPrompt(options.task, workerResult), options.cwd)
        : await runAgent(reviewer, followUpReviewPrompt(workerResult), options.cwd);

    console.log(`\n===== REVIEW ${reviewNumber} =====\n`);
    console.log(review);

    if (reviewComplete(review)) {
      const summary = await runAgent(worker, workerFollowUpPrompt(review), options.cwd);
      console.log("\n===== SUMMARY =====\n");
      console.log(summary);
      return;
    }

    if (reviewNumber >= options.maxReviews) {
      console.error(`\nStopped after ${options.maxReviews} reviews with findings remaining.`);
      process.exitCode = 2;
      return;
    }

    workerResult = await runAgent(worker, workerFollowUpPrompt(review), options.cwd);

    console.log(`\n===== IMPLEMENTATION ${reviewNumber + 1} =====\n`);
    console.log(workerResult);
  }
}

main().catch((error) => {
  console.error(`\n${error.stack ?? error.message ?? error}`);
  process.exitCode = 1;
});
