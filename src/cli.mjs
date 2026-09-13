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
    task: "Review the current worktree changes.",
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

  if (!Number.isInteger(options.maxReviews) || options.maxReviews < 1) {
    throw new Error("--max-reviews must be a positive integer.");
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:

  node review-loop.mjs \\
    --reviewer codex \\
    --worker claude \\
    --task "Review the current branch against main."

Options:

  --reviewer <agent>
  --worker <agent>
  --cwd <directory>
  --task <review task>
  --max-reviews <count>

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

async function exec(command, args, cwd) {
  const result = await execa(command, args, {
    cwd,
    reject: false,
    stdin: "ignore",
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
  const result = parseJson(stdout, "Claude Code");

  if (!result.session_id) {
    throw new Error("Claude Code did not return a session_id.");
  }

  state.sessionId = result.session_id;

  return String(result.result ?? "").trim();
}

async function runCodex(state, prompt, cwd) {
  const args = state.sessionId
    ? ["exec", "resume", state.sessionId, "--json", prompt]
    : ["exec", "--json", prompt];

  const { stdout } = await exec("codex", args, cwd);
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

  args.push(prompt);

  const { stdout } = await exec(command, args, cwd);
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

  const args = ["--session-id", state.sessionId, "-p", prompt, "-s", "--no-ask-user"];

  const { stdout } = await exec("copilot", args, cwd);

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
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1) === COMPLETE_MARKER;
}

function initialReviewPrompt(task) {
  return `
You are the reviewer in an automated review loop.

Task:
${task}

Inspect the actual repository state.

Do not modify files.

Report every actionable issue that the implementation agent must address.

For each finding, give enough detail to locate and fix the issue.

If any actionable finding remains, do not output ${COMPLETE_MARKER}.

If no actionable finding remains, end your response with this exact line:

${COMPLETE_MARKER}
`.trim();
}

function workerPrompt(findings) {
  return `
You are the implementation agent in an automated review loop.

Address every actionable review finding below.

Inspect the actual repository state before you make changes.

Modify the implementation as needed.

Run relevant tests, checks, or validation.

Do not merely explain what must change.

When complete, summarize:
- what you changed
- what you verified
- any finding that you intentionally did not address and why

Review findings:

${findings}
`.trim();
}

function followUpReviewPrompt(workerResult) {
  return `
The implementation agent reports the following work:

${workerResult}

Reinspect the actual repository state.

Do not trust the implementation report as proof that the findings are resolved.

Verify the previous findings against the current files.

Also check for regressions or new actionable issues caused by the fixes.

Do not modify files.

If any actionable finding remains, report it and do not output ${COMPLETE_MARKER}.

If no actionable finding remains, end your response with this exact line:

${COMPLETE_MARKER}
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

  let review = await runAgent(reviewer, initialReviewPrompt(options.task), options.cwd);

  for (let reviewNumber = 1; ; reviewNumber++) {
    console.log(`\n===== REVIEW ${reviewNumber} =====\n`);
    console.log(review);

    if (reviewComplete(review)) {
      console.log("\nReview loop complete.");
      return;
    }

    if (reviewNumber >= options.maxReviews) {
      console.error(`\nStopped after ${options.maxReviews} reviews with findings remaining.`);
      process.exitCode = 2;
      return;
    }

    const workerResult = await runAgent(worker, workerPrompt(review), options.cwd);

    console.log(`\n===== IMPLEMENTATION ${reviewNumber} =====\n`);
    console.log(workerResult);

    review = await runAgent(reviewer, followUpReviewPrompt(workerResult), options.cwd);
  }
}

main().catch((error) => {
  console.error(`\n${error.stack ?? error.message ?? error}`);
  process.exitCode = 1;
});
