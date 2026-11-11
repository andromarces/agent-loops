// The headless worker side of a batch: the child argv, the setup command, and the child process.
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { renderTask, DEFAULT_TASK_TEMPLATE, DEFAULT_PR_TASK_TEMPLATE } from "./args.mjs";
import { endSubprocessTree, killTreeOnExit } from "../lib/exec-tree.mjs";
import { processStartTime } from "../lib/process-identity.mjs";
import { execBounded } from "../lib/exec.mjs";

/** The argv of one headless run. No shell shim, and the child receives only explicit flags. */
export function childArguments({ prepared, loop, workTree, transcript, maxSteps, resume }) {
  const kind = loop.kind ?? "issue";
  const mode = loop.mode ?? "work-first";
  const args = [
    "--orchestrator",
    prepared.roles.orchestrator.kind,
    "--worker",
    prepared.roles.worker.kind,
    "--reviewer",
    prepared.roles.reviewer.kind,
    "--cwd",
    workTree,
    "--task",
    loop.task,
    "--max-steps",
    String(maxSteps),
    "--transcript",
    transcript,
  ];
  if (kind === "pr" || mode !== "work-first") args.push("--mode", mode);
  if (mode !== "review-only") args.push("--require-accept");
  for (const role of ["orchestrator", "worker", "reviewer"]) {
    const { model, effort } = prepared.roles[role];
    if (model) args.push(`--${role}-model`, model);
    if (effort) args.push(`--${role}-effort`, effort);
  }
  if (prepared.testCmd) args.push("--test-cmd", prepared.testCmd);
  if (prepared.testCmdTimeout) args.push("--test-cmd-timeout", String(prepared.testCmdTimeout));
  args.push("--timeout", String(prepared.timeout ?? 0));
  if (prepared.reviewerSandbox) args.push("--reviewer-sandbox", prepared.reviewerSandbox);
  if (resume.continueFrom) args.push("--continue-from", resume.continueFrom);
  const pr = resume.pr ?? (kind === "pr" ? loop.pr : null);
  if (mode !== "review-only" && pr !== null && pr !== undefined) {
    args.push("--pr", String(pr), "--require-ci", String(pr));
  }
  return args;
}

function shellCommand(command) {
  return process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]]
    : ["/bin/sh", ["-c", command]];
}

/** Runs `--setup-cmd` once in the new work tree through the platform shell, within its bound. */
export async function runSetup({ command, workTree, timeoutSeconds, signal = null, deps = {} }) {
  if (signal?.aborted) return false;
  const run = deps.execBounded ?? execBounded;
  const [file, args] = shellCommand(command);
  const result = await run(file, args, {
    cwd: workTree,
    timeoutMs: timeoutSeconds * 1000,
    signal,
  });
  return result.exitCode === 0 && !result.isCanceled && !signal?.aborted;
}

function cliPath() {
  return fileURLToPath(new URL("../cli.mjs", import.meta.url));
}

/** Returns a child that has a process id, and reports one that never started as an error. */
async function startedChild(child) {
  if (child.pid != null) return child;
  const { error } = await child.done;
  child.close?.();
  throw error ?? new Error("the child did not start");
}

/** Spawns one headless run with stdout and stderr appended to `logPath`. */
export async function spawnHeadless({ args, cwd, logPath, deps = {} }) {
  if (deps.spawn) return startedChild(await deps.spawn({ args, cwd, logPath }));
  // Execa opens one shared append stream for both output streams. It closes the stream on a normal
  // end or a spawn failure.
  const subprocess = killTreeOnExit(
    execa(process.execPath, [cliPath(), ...args], {
      cwd,
      reject: false,
      stdin: "ignore",
      stdout: { file: logPath, append: true },
      stderr: { file: logPath, append: true },
      killDescendants: true,
    }),
  );
  const pid = subprocess.pid ?? null;
  // With reject false, execa resolves a spawn failure as a failed result, not a rejection.
  const done = subprocess.then(
    (result) => ({
      exitCode: result.exitCode ?? null,
      error: result.failed ? result : null,
    }),
    (error) => ({ exitCode: null, error }),
  );
  return startedChild({
    pid,
    startTime: pid === null ? null : await processStartTime(pid),
    done,
    kill: (signal = "SIGINT") => {
      try {
        subprocess.kill(signal);
      } catch {
        // A run that already ended needs no signal.
      }
    },
    hardKill: () => {
      try {
        endSubprocessTree(subprocess);
      } catch {
        // A run that already ended needs no signal.
      }
    },
  });
}
/** The task text of one item. An explicit per-item task replaces the template for that item. */
export function taskTextFor({ item, loop, prepared, title, branch }) {
  if (typeof item.task === "string" && item.task.trim() !== "") return item.task;
  if (item.kind === "task") {
    const base = item.text ?? loop.text ?? "";
    const delivery =
      item.mode === "review-only"
        ? "Review the work in this work tree and finish after the reviewer turn."
        : `Commit the change on branch ${branch}, push it with \`git push -u origin ${branch}\`, and open one pull request against the base branch whose body states the task and holds no closing keyword.`;
    return `${base}\n\n${delivery}`;
  }
  const template =
    item.kind === "pr" && prepared.taskTemplate === DEFAULT_TASK_TEMPLATE
      ? DEFAULT_PR_TASK_TEMPLATE
      : prepared.taskTemplate;
  return renderTask(template, {
    issue: item.number ?? item.key,
    title,
    branch,
    repo: prepared.repo,
  });
}
