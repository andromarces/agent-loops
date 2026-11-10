import { escapeLineSeparators } from "./escape.mjs";
import {
  hookTestSlotRule,
  initTaskBlock,
  PR_BODY_SCOPE,
  probeCopyRule,
  processRule,
  redRunRule,
  reportBlock,
  secretFileRule,
  tempPathRule,
  tempRemovalRule,
  testSlotRule,
  unnamedHostRule,
} from "./rules.mjs";

// A closing keyword in a commit message closes the issue at merge, even after the PR body changes
// to `Refs` (issue #1296).
const commitLinkRule =
  "Link an issue only in the pull request body or the Development panel. Never put a closing keyword, such as `Closes`, `Fixes`, or `Resolves`, in a commit message.";

const prBodyRule = `After each push, if the branch has an open pull request, update the pull request body in place so that it describes the pushed head. Add no revision log to the body or to a comment. ${PR_BODY_SCOPE}`;

// A worker wrote a PR body whose closing keyword sat inside a code span, so GitHub recorded no link.
// The issue stayed unlinked (issue #1560).
const closingIssuesRule =
  "After you set or edit a pull request body that links an issue with a closing keyword, read `gh pr view <pr> --json closingIssuesReferences`. Fix the body until the issue is listed.";

// A worker ran the test suite and committed an unignored Vitest report with `git add -A`
// (issue #1510).
const stageOnlyNeededPathsRule =
  "Stage only the paths that the change needs, by name. Never stage with `git add -A`, `git add .`, or `git commit -a`. Before each commit, read `git diff --cached --stat`, and unstage any generated, cache, or test output file. When a run leaves untracked generated output that the repository does not ignore, report it in `Notes`, and do not commit it.";

// Under `push.default=matching`, a plain `git push` also pushes other local branches. Those are the
// branches that have a remote branch of the same name. A linked work tree shares such a default
// branch with the main checkout (issue #1226). A named refspec keeps the push on the PR branch.
const namedPushRule =
  "Push only with `git push -u origin <branch>`, which names the refspec, and never with a plain `git push`.";
const matchingPushNote =
  "Under `push.default=matching`, a plain `git push` also pushes each local branch with a same-name remote branch, such as the default branch.";

// A worker piped `git push` through `tail`, so the pre-push hook output was cut and its result never
// reached Checks (issue #1533). A hook can print a warning or a phase result that the turn needs.
const hookOutputRule =
  "Never pipe `git commit` or `git push` through a filter that cuts the hook output, such as `tail` or `head`. Keep the full output of a commit or push hook, or at least its failing and summary lines. Report the hook result in Checks.";

// The pnpm dependency check also defaults to install in the run work tree.
// A worker command there can run the project lifecycle scripts (issue #1385).
const pnpmRunRule =
  "A `pnpm run` or `pnpm exec` in the run work tree must not install. Set `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` for the command, or call the installed binary directly.";

// A junction to another checkout's `node_modules` lets `vp` rewrite that checkout's links
// (issue #1057).
const ownNodeModulesRule =
  "Use the own `node_modules` of this work tree, which the parent installed before the first dispatch. Never link or junction the `node_modules` of another checkout into this work tree, and never run an install in another checkout.";

// A worker turn in a linked work tree edited the main checkout instead, and a code index can
// return absolute paths of another checkout (issue #1494).
const workTreeEditRule =
  "Edit, create, and delete files only under the run work tree. Before an edit with an absolute path, check that the path starts with the work tree root. A path that a tool returns for another checkout maps to the same relative path in the run work tree.";

// A worker whose edit landed in another checkout restored the files there, which can discard an
// uncommitted change of the user, and its own envelope then named no path (issue #1551).
const foreignCheckoutEditRule =
  "If an edit lands in another checkout, report the paths in the closing block and stop. Never restore or discard a file there. A restore can discard an uncommitted change of the user.";

// Every turn runs with a private temporary directory that the runtime removes (ADR 0047, ADR 0068).
// A literal `/tmp` path in Git Bash resolves to the inherited directory, which that removal does not
// cover, so a scratch file there outlives the turn and shows up as a reviewer
// `inheritedTmpdirEntries` entry (issue #1249). The reviewer prompt carries the same rule (issue #1024).
// A literal `/tmp` path stays forbidden even when TMPDIR names another directory, because another
// run can hold the same name (issue #1596). The runtime reports such a write on POSIX as a
// `literal-tmp/` entry when the inherited directory is another path (issue #1713).
const tmpdirRule = tempPathRule(
  "work tree",
  ", such as `/tmp`. Never write a literal `/tmp` path, even when TMPDIR names another directory. Another run can hold the same name",
);

// A Claude worker moved its suite to a background shell task when it could outlive the foreground
// bound, then ended the turn with no closing block (issue #1530).
const longSuiteRule =
  "Never end the turn while a command that you started is still running. When a test command can outlive the shell tool bound of the harness, such as the 10-minute Claude Code bound, rely on the required CI checks and report the local suite as not run in `Checks`; never move it to the background.";

// A worker that waits on CI outlives its turn timeout after the push, and its work is already done
// (issue #1459).
const ciWaitRule =
  "Never wait for CI with an unbounded command, such as `gh pr checks --watch`. The run waits for the required checks outside the worker turn with `role wait-checks`, where the run permits it. A worker that must read CI, for example for a flaky check, uses a bounded read.";

// A Claude worker put the reasons under an unlabeled `Verification:` heading on a first turn.
// The block parsed to null for the missing `Why:` label (issue #1601). Later turns repeated the
// omission in prose and bold-lead lists, so every turn carries the rule (issue #1613).
const reasonsUnderWhyRule =
  "Put the reasons under `Why:`, never under another heading such as `Verification:`.";

// A Claude worker opened later turns with a prose sentence and put requested values on lines of
// their own, so the response had no `Conclusion:` line and the report parsed to null (issue #1179).
const conclusionFirstRule =
  "The block must open with the `Conclusion:` line. A response with no `Conclusion:` line has no block. The parent then reads the response as raw text. State a requested value, such as a head SHA or a PR number, inside a label line of the block, never on a line of its own.";

// A later turn resumes the same session and gets no preamble, so it never learns that TMPDIR
// changed (issue #1610). A worker that reused a temporary path from an earlier turn wrote to a
// directory that the runtime had already removed.
const laterTurnTmpdirRule =
  "`TMPDIR` names a new private directory on every turn, so read it again, and never reuse a temporary path from an earlier turn.";

/**
 * Builds a worker turn prompt. `firstTurn` adds the full preamble; a later turn gets the push,
 * body, commit-link, staging, temporary-path, and closing-block rules only. `task` adds the init
 * task block. `slotOptions` overrides the Node and CLI paths of the slot rules, as `testSlotRule`
 * accepts.
 */
export function workerPrompt(prompt, firstTurn = false, task = null, slotOptions = {}) {
  if (!firstTurn) {
    // A later turn can commit and push a fix in a conversation that has no preamble yet, so it
    // repeats the PR body, named push, commit-link, staging, and temporary-path rules. It repeats the closing block too, because a worker drifts from the block as the
    // conversation grows (issue #1118), and names the `Conclusion:` line as its required first line
    // (issue #1179).
    return escapeLineSeparators(`${prompt}

${namedPushRule}

${matchingPushNote}

${hookOutputRule}

${prBodyRule}

${closingIssuesRule}

${commitLinkRule}

${stageOnlyNeededPathsRule}

${laterTurnTmpdirRule}

${conclusionFirstRule}

${reasonsUnderWhyRule}

${reportBlock}`);
  }

  return escapeLineSeparators(
    `
You are the implementation agent (worker) in an automated loop.
Your role:
- Implement the requested changes.
- Run tests, checks, and verifications to confirm correctness.
  If the CLI refuses a command, never report it as run. Name the refusal in Checks and Blockers.
- ${testSlotRule(slotOptions)}
- ${redRunRule(slotOptions)}
- ${hookTestSlotRule(slotOptions)}
- ${longSuiteRule}
- ${ciWaitRule}
- ${unnamedHostRule({ namesHost: true })}
- ${ownNodeModulesRule}
- ${probeCopyRule("work tree")}
- ${pnpmRunRule}
- For PR work, the dispatcher names the PR branch. Commit your change on that
  branch and push it, so the reviewer sees a committed head and the PR head
  matches that commit. A task is PR work when its change is delivered on a pull
  request.
- ${namedPushRule}
- ${matchingPushNote}
- ${hookOutputRule}
- ${prBodyRule}
- ${closingIssuesRule}
- ${commitLinkRule}
- ${stageOnlyNeededPathsRule}
- For PR work, before the closing block, \`git status --porcelain\` must be empty, ignored files aside. Commit or discard every change, and name in Notes any change that you keep on purpose.
- The work tree this turn runs in belongs to the parent. Never remove, move, or
  switch it, and leave it in place after the push. Every later turn of
  this run targets the same \`--cwd\`.
- ${workTreeEditRule}
- ${foreignCheckoutEditRule}
- Report what changed, what was verified, and state any disagreements with evidence.
- State every result the parent needs, such as findings, drafts, decisions, and open questions, inside the closing block, in full on its label line. The one exception is quoted or multi-paragraph text, which goes before the block with one label that refers to it. The closing-block rule below states it. Never refer to any other text outside the block, for example "the decisions above". The parent reads only the block.
- Start no background watcher, Monitor, or poller. Wait for each result in the foreground.
- ${tmpdirRule}
- ${tempRemovalRule("work tree", " A PR body file in the system temporary directory is one example.")}
- ${processRule}
- ${secretFileRule}
- If a late event arrives after the closing block, end again with the closing block for the whole turn. The parent reads only your last message.
- ${reasonsUnderWhyRule}
- You do NOT decide when the loop ends.

${reportBlock}

${initTaskBlock(task)}Instructions:
${prompt}
`.trim(),
  );
}
