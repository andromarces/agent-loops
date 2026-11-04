import { escapeLineSeparators } from "./escape.mjs";
import {
  initTaskBlock,
  PR_BODY_SCOPE,
  probeCopyRule,
  processRule,
  reportBlock,
  secretFileRule,
  tempPathRule,
  tempRemovalRule,
  testSlotRule,
} from "./report.mjs";

// A closing keyword in a commit message closes the issue at merge, even after the PR body changes
// to `Refs` (issue #1296).
const commitLinkRule =
  "Link an issue only in the pull request body or the Development panel. Never put a closing keyword, such as `Closes`, `Fixes`, or `Resolves`, in a commit message.";

const prBodyRule = `After each push, if the branch has an open pull request, update the pull request body in place so that it describes the pushed head. Add no revision log to the body or to a comment. ${PR_BODY_SCOPE}`;

// Under `push.default=matching`, a plain `git push` also pushes other local branches. Those are the
// branches that have a remote branch of the same name. A linked work tree shares such a default
// branch with the main checkout (issue #1226). A named refspec keeps the push on the PR branch.
const namedPushRule =
  "Push only with `git push -u origin <branch>`, which names the refspec, and never with a plain `git push`.";
const matchingPushNote =
  "Under `push.default=matching`, a plain `git push` also pushes each local branch with a same-name remote branch, such as the default branch.";

// The pnpm dependency check also defaults to install in the run work tree.
// A worker command there can run the project lifecycle scripts (issue #1385).
const pnpmRunRule =
  "A `pnpm run` or `pnpm exec` in the run work tree must not install. Set `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` for the command, or call the installed binary directly.";

// A junction to another checkout's `node_modules` lets `vp` rewrite that checkout's links
// (issue #1057).
const ownNodeModulesRule =
  "Use the own `node_modules` of this work tree, which the parent installed before the first dispatch. Never link or junction the `node_modules` of another checkout into this work tree, and never run an install in another checkout.";

// Every turn runs with a private temporary directory that the runtime removes (ADR 0047, ADR 0068).
// A literal `/tmp` path in Git Bash resolves to the inherited directory, which that removal does not
// cover, so a scratch file there outlives the turn and shows up as a reviewer
// `inheritedTmpdirEntries` entry (issue #1249). The reviewer prompt carries the same rule (issue #1024).
const tmpdirRule = tempPathRule("work tree", ", such as `/tmp` or `%TEMP%`");

// A worker that waits on CI outlives its turn timeout after the push, and its work is already done
// (issue #1459).
const ciWaitRule =
  "Never wait for CI with an unbounded command, such as `gh pr checks --watch`. The parent, or the headless orchestrator, waits for the required checks with `role wait-checks`. A worker that must read CI, for example for a flaky check, uses a bounded read.";

// A Claude worker opened later turns with a prose sentence and put requested values on lines of
// their own, so the response had no `Conclusion:` line and the report parsed to null (issue #1179).
const conclusionFirstRule =
  "The block must open with the `Conclusion:` line. A response with no `Conclusion:` line has no block. The parent then reads the response as raw text. State a requested value, such as a head SHA or a PR number, inside a label line of the block, never on a line of its own.";

/**
 * Builds a worker turn prompt. `firstTurn` adds the full preamble; a later turn gets the push,
 * body, and closing-block rules only. `task` adds the init task block.
 */
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

${commitLinkRule}

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
- ${ciWaitRule}
- ${ownNodeModulesRule}
- ${probeCopyRule("work tree")}
- ${pnpmRunRule}
- For PR work, the dispatcher names the PR branch. Commit your change on that
  branch and push it, so the reviewer sees a committed head and the PR head
  matches that commit. A task is PR work when its change is delivered on a pull
  request.
- ${namedPushRule}
- ${matchingPushNote}
- ${prBodyRule}
- ${commitLinkRule}
- For PR work, before the closing block, \`git status --porcelain\` must be empty, ignored files aside. Commit or discard every change, and name in Notes any change that you keep on purpose.
- The work tree this turn runs in belongs to the parent. Never remove, move, or
  switch it, and leave it in place after the push, because every later turn of
  this run targets the same \`--cwd\`.
- Report what changed, what was verified, and state any disagreements with evidence.
- State every result the parent needs, such as findings, drafts, decisions, and open questions, inside the closing block, in full on its label line. Never refer to text outside the block, for example "the decisions above", because the parent reads only the block.
- Start no background watcher, Monitor, or poller. Wait for each result in the foreground.
- ${tmpdirRule}
- ${tempRemovalRule("work tree", " A PR body file in the system temporary directory is one example.")}
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
