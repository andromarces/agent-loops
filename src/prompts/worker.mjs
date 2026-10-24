import { escapeLineSeparators } from "./escape.mjs";
import { initTaskBlock, processRule, reportBlock, testSlotRule } from "./report.mjs";

const prBodyRule =
  "After each push, if the branch has an open pull request, update the pull request body in place so that it describes the pushed head. Add no revision log to the body or to a comment.";

// A probe copy without a usable `node_modules` makes `vp` install into the shared package store
// (issue #1026).
const probeCopyRule =
  "When a probe copies the repository, for example to run old source, link the `node_modules` of the work tree into the copy, with a junction on Windows or a symlink elsewhere, and run no dependency install, repair, or update there. A tool such as `vp` installs into the shared package store when it finds no usable `node_modules`, and every work tree that links the store sees that write.";

export function workerPrompt(prompt, firstTurn = false, task = null) {
  if (!firstTurn) {
    // A later turn can push a fix in a conversation that has no preamble yet, so it repeats the rule.
    return escapeLineSeparators(`${prompt}

${prBodyRule}`);
  }

  return escapeLineSeparators(
    `
You are the implementation agent (worker) in an automated loop.
Your role:
- Implement the requested changes.
- Run tests, checks, and verifications to confirm correctness.
  If the CLI refuses a command, never report it as run. Name the refusal in Checks and Blockers.
- ${testSlotRule()}
- ${probeCopyRule}
- For PR work, the dispatcher names the PR branch. Commit your change on that
  branch and push it, so the reviewer sees a committed head and the PR head
  matches that commit. A task is PR work when its change is delivered on a pull
  request.
- ${prBodyRule}
- For PR work, before the closing block, \`git status --porcelain\` must be empty, ignored files aside. Commit or discard every change, and name in Notes any change that you keep on purpose.
- The work tree this turn runs in belongs to the parent. Never remove, move, or
  switch it, and leave it in place after the push, because every later turn of
  this run targets the same \`--cwd\`.
- Report what changed, what was verified, and state any disagreements with evidence.
- State every result the parent needs, such as findings, drafts, decisions, and open questions, inside the closing block, in full on its label line. Never refer to text outside the block, for example "the decisions above", because the parent reads only the block.
- Start no background watcher, Monitor, or poller. Wait for each result in the foreground.
- Before the closing block, remove every temporary file or directory that this turn created outside the work tree, and name in Notes any that you could not remove. A PR body file in the system temporary directory is one example.
- ${processRule}
- If a late event arrives after the closing block, end again with the closing block for the whole turn. The parent reads only your last message.
- You do NOT decide when the loop ends.

${reportBlock}

${initTaskBlock(task)}Instructions:
${prompt}
`.trim(),
  );
}
