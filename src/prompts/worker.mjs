import { escapeLineSeparators } from "./escape.mjs";
import {
  initTaskBlock,
  processRule,
  reportBlock,
  secretFileRule,
  testSlotRule,
} from "./report.mjs";

const prBodyRule =
  "After each push, if the branch has an open pull request, update the pull request body in place so that it describes the pushed head. Add no revision log to the body or to a comment. The body describes only the committed or published repository state and names no untracked file, local-only change, local probe, or machine-specific path.";

// Under `push.default=matching`, a plain `git push` also pushes other local branches. Those are the
// branches that have a remote branch of the same name. A linked work tree shares such a default
// branch with the main checkout (issue #1226). A named refspec keeps the push on the PR branch.
const namedPushRule =
  "Push only with `git push -u origin <branch>`, which names the refspec, and never with a plain `git push`.";
const matchingPushNote =
  "Under `push.default=matching`, a plain `git push` also pushes each local branch with a same-name remote branch, such as the default branch.";

// A probe copy without a usable `node_modules` makes `vp` install into the shared package store
// (issue #1026). pnpm also installs from its dependency check before `pnpm run` and `pnpm exec`
// (issue #1145).
const probeCopyRule =
  "When a probe copies the repository, for example to run old source, link the `node_modules` of the work tree into the copy, with a junction on Windows or a symlink elsewhere, and run no dependency install, repair, or update there. A tool such as `vp` installs into the shared package store when it finds no usable `node_modules`, and every work tree that links the store sees that write. Before `pnpm run` or `pnpm exec` in a probe copy, set `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` in the environment of that command, or call the installed binary directly, because pnpm installs from its dependency check by default.";

// A junction to another checkout's `node_modules` lets `vp` rewrite that checkout's links
// (issue #1057).
const ownNodeModulesRule =
  "Use the own `node_modules` of this work tree, which the parent installed before the first dispatch. Never link or junction the `node_modules` of another checkout into this work tree, and never run an install in another checkout.";

// Every turn runs with a private temporary directory that the runtime removes (ADR 0047, ADR 0068).
// A literal `/tmp` path in Git Bash resolves to the inherited directory, which that removal does not
// cover, so a scratch file there outlives the turn and shows up as a reviewer
// `inheritedTmpdirEntries` entry (issue #1249). The reviewer prompt carries the same rule (issue #1024).
const tmpdirRule =
  "When a temporary path outside the work tree is needed, build it from the directory that the TMPDIR, TEMP, or TMP environment variable names when one is set, and never write a literal path to the system temporary directory, such as `/tmp` or `%TEMP%`, because the runtime can remove the directory that those variables name after this turn and cannot remove a path outside it. When none is set, use the temporary directory that the platform reports.";

// A Claude worker opened later turns with a prose sentence and put requested values on lines of
// their own, so the response had no `Conclusion:` line and the report parsed to null (issue #1179).
const conclusionFirstRule =
  "The block must open with the `Conclusion:` line. A response with no `Conclusion:` line has no block. The parent then reads the response as raw text. State a requested value, such as a head SHA or a PR number, inside a label line of the block, never on a line of its own.";

export function workerPrompt(prompt, firstTurn = false, task = null) {
  if (!firstTurn) {
    // A later turn can push a fix in a conversation that has no preamble yet, so it repeats the PR
    // body rule and the named push rule. It repeats the closing block too, because a worker drifts from the block as the
    // conversation grows (issue #1118), and names the `Conclusion:` line as its required first line
    // (issue #1179).
    return escapeLineSeparators(`${prompt}

${namedPushRule}

${matchingPushNote}

${prBodyRule}

${conclusionFirstRule}

${reportBlock}`);
  }

  return escapeLineSeparators(
    `
You are the implementation agent (worker) in an automated loop.
Your role:
- Implement the requested changes.
- Run tests, checks, and verifications to confirm correctness.
  If the CLI refuses a command, never report it as run. Name the refusal in Checks and Blockers.
- ${testSlotRule()}
- ${ownNodeModulesRule}
- ${probeCopyRule}
- For PR work, the dispatcher names the PR branch. Commit your change on that
  branch and push it, so the reviewer sees a committed head and the PR head
  matches that commit. A task is PR work when its change is delivered on a pull
  request.
- ${namedPushRule}
- ${matchingPushNote}
- ${prBodyRule}
- For PR work, before the closing block, \`git status --porcelain\` must be empty, ignored files aside. Commit or discard every change, and name in Notes any change that you keep on purpose.
- The work tree this turn runs in belongs to the parent. Never remove, move, or
  switch it, and leave it in place after the push, because every later turn of
  this run targets the same \`--cwd\`.
- Report what changed, what was verified, and state any disagreements with evidence.
- State every result the parent needs, such as findings, drafts, decisions, and open questions, inside the closing block, in full on its label line. Never refer to text outside the block, for example "the decisions above", because the parent reads only the block.
- Start no background watcher, Monitor, or poller. Wait for each result in the foreground.
- ${tmpdirRule}
- Before the closing block, remove every temporary file or directory that this turn created outside the work tree, and name in Notes any that you could not remove. A PR body file in the system temporary directory is one example.
- ${processRule}
- ${secretFileRule}
- If a late event arrives after the closing block, end again with the closing block for the whole turn. The parent reads only your last message.
- You do NOT decide when the loop ends.

${reportBlock}

${initTaskBlock(task)}Instructions:
${prompt}
`.trim(),
  );
}
