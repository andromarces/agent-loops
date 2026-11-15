// The loop launch of one batch (adr/0106-foreground-batch-scheduling.md decisions 4 to 7). It
// checks eligibility, takes the claim, creates or verifies the work tree, and starts the child.
// Every shared collection and every dependency is a parameter, so a launch holds no supervisor
// closure. It reads no manifest and writes one loop checkpoint per step, as before.
import { join } from "node:path";
import { logError } from "../lib/log.mjs";
import { processStartTime } from "../lib/process-identity.mjs";
import { checkItemEligibility, readOpenPrClosures } from "./eligibility.mjs";
import { loopSegment } from "./items.mjs";
import { progress } from "./loop-records.mjs";
import { acquireClaim, readClaim, readLoop, releaseClaim } from "./store.mjs";
import { childArguments, runSetup, spawnHeadless, taskTextFor } from "./worker.mjs";

/** The branch refusals that skip a pull request item instead of failing the batch. */
export const PR_BRANCH_REFUSALS = new Set([
  "pr-head-moved",
  "pr-branch-diverged",
  "pr-branch-checked-out",
]);

let ownStamp;
function ownStartTimeOnce() {
  ownStamp ??= processStartTime(process.pid);
  return ownStamp;
}

/** One line of the failure text, without the child argument list, for a loop reason. */
function spawnFailureText(error) {
  const cause = error?.cause?.message ?? error?.originalMessage ?? error?.message;
  const text = String(cause ?? "the child did not start").split("\n")[0];
  const code = typeof error?.code === "string" ? error.code : null;
  return code === null || text.includes(code) ? text : `${code}: ${text}`;
}

/** Clears a stored undeclared PR when a declared one replaces it. An absent declaration keeps it. */
function clearUndeclared(pr) {
  return pr === null || pr === undefined ? {} : { prUndeclared: null };
}

/**
 * The loop launch of one batch. `loops`, `slots`, `waiting`, `children`, and `active` belong to the
 * running batch. `isStopped` reads its interruption state and `setPausedReason` records a batch-wide
 * pause. `finishSuccess`, `continueLoop`, `markNeedsOwner`, and `settleChild` hand a decided loop
 * back to the run.
 */
export function createLoopLauncher({
  runsRoot,
  batchId,
  paths,
  prepared,
  deps,
  gh,
  loops,
  slots,
  waiting,
  children,
  active,
  signal,
  isStopped,
  changeLoop,
  notify,
  planTree,
  createWorkTree,
  createPullRequestWorkTree,
  verifyWorkTree,
  reconcile,
  markNeedsOwner,
  finishSuccess,
  continueLoop,
  settleChild,
  setPausedReason,
}) {
  // The repository of the last open pull request read saves one `repo view` per launch.
  let openPrRepository = null;
  const refreshOpenPr = async () => {
    try {
      const closures = await readOpenPrClosures({
        gh,
        repo: prepared.repo,
        repository: openPrRepository,
      });
      openPrRepository = closures.repository;
      return closures;
    } catch (err) {
      throw Object.assign(new Error(`the open pull request read failed: ${err.message}`), {
        batchWide: true,
      });
    }
  };

  // A skipped launch writes one checkpoint, releases the claim when asked, then reports one line.
  const skipLoop = async (
    issue,
    { skipReason, reason, detail = null, extra = {}, release = false },
  ) => {
    await changeLoop(issue, { status: "skipped", skipReason, reason, ...extra });
    if (release) await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId });
    progress(`issue ${issue}: skipped (${detail ?? `${skipReason}: ${reason}`})`);
  };

  // The eligibility step reads the open pull requests and the item state, and it ends the launch
  // when the item waits or is skipped. It returns the claim read and the issue title.
  const launchEligibility = async (issue, { item, loop }) => {
    let closures = null;
    if (item.kind === "issue") {
      try {
        closures = await refreshOpenPr();
      } catch (err) {
        setPausedReason(err.message);
        await changeLoop(issue, {
          status: "queued",
          reason: "eligibility-unverified",
          skipReason: "eligibility-unverified",
        });
        throw err;
      }
      if (closures.incompletePr !== null) {
        const reason = `pull request ${closures.incompletePr} returned a 250-commit page`;
        setPausedReason(reason);
        await changeLoop(issue, {
          status: "queued",
          skipReason: "eligibility-unverified",
          reason,
        });
        throw Object.assign(new Error(reason), { batchWide: true });
      }
    }
    const claim = await readClaim(runsRoot, prepared.repoKey, issue);
    const eligibility = await checkItemEligibility({
      item,
      gh,
      repo: prepared.repo,
      batchId,
      claim,
      openPrClosures: closures,
      ownPr: loop.pr ?? loop.prUndeclared ?? null,
      ownBranch: loop.branch,
      requireSpecification: prepared.requireSpecification === true,
    });
    if (!eligibility.ok) {
      if (eligibility.reason === "blocked") {
        waiting.add(issue);
        const changed = await changeLoop(issue, {
          status: "waiting",
          skipReason: "blocked",
          reason: eligibility.evidence,
          blockingIssues: eligibility.blocking ?? [],
          remainingSteps: loop.remainingSteps,
          pid: null,
          startTime: null,
        });
        progress(`issue ${issue}: waiting (${eligibility.evidence})`);
        if (changed) {
          await notify({
            kind: "merge-required",
            title: "Batch merge required",
            text: `Batch ${batchId} issue ${issue} waits for the merge of blocking issue(s) ${(eligibility.blocking ?? []).join(", ")}.`,
          });
        }
        return null;
      }
      await skipLoop(issue, {
        skipReason: eligibility.reason,
        reason: eligibility.evidence,
        extra: { remainingSteps: loop.remainingSteps },
      });
      return null;
    }
    const itemTitle = eligibility.title ?? null;
    if (item.kind === "pr") {
      try {
        await planTree({
          repo: prepared.repo,
          branch: loop.branch,
          head: loop.head,
          number: item.number,
        });
      } catch (err) {
        if (!PR_BRANCH_REFUSALS.has(err?.code)) {
          throw err;
        }
        await skipLoop(issue, {
          skipReason: err.code,
          reason: err.message,
          extra: { remainingSteps: loop.remainingSteps },
        });
        return null;
      }
    }
    return { claim, itemTitle };
  };

  // The claim step acquires the item claim unless this batch already holds it.
  const launchClaim = async (issue, { claim }) => {
    const ownClaim = claim.exists && claim.record?.batchId === batchId;
    const claimResult = ownClaim
      ? { acquired: true }
      : await acquireClaim(
          runsRoot,
          prepared.repoKey,
          issue,
          {
            batchId,
            repo: prepared.repo,
            workTree: prepared.workTreeRoot,
            pid: process.pid,
            startTime: await ownStartTimeOnce(),
          },
          {
            onStale: async (record) => {
              if (record.batchId === batchId) return true;
              const owner = await readLoop(runsRoot, record.batchId, issue).catch(() => null);
              return owner?.status === "failed";
            },
          },
        );
    if (!claimResult.acquired) {
      await skipLoop(issue, {
        skipReason: "claimed",
        reason: `claimed by batch ${claimResult.owner ?? "unknown"}`,
        detail: `claimed by batch ${claimResult.owner ?? "unknown"}`,
      });
      return false;
    }
    return true;
  };

  // The work tree step builds the task, creates or verifies the work tree, and marks the loop
  // queued. It returns the updated loop and the continuation facts.
  const launchWorkTree = async (issue, { item, loop, itemTitle }) => {
    let title = item.kind === "issue" ? `issue ${item.number}` : `pull request ${item.number}`;
    if (item.kind === "pr" && typeof loop.prTitle === "string" && loop.prTitle.trim() !== "") {
      title = loop.prTitle;
    }
    if (item.kind === "issue" && typeof itemTitle === "string" && itemTitle.trim() !== "") {
      title = itemTitle;
    }
    const task = taskTextFor({
      item,
      loop,
      prepared,
      title,
      branch: loop.branch,
    });
    const workTreePath = join(prepared.workTreeRoot, loopSegment(issue));
    const recordedWorkTree = loop.workTree;
    let workTree = recordedWorkTree;
    try {
      if (workTree === null || workTree === undefined) {
        workTree =
          item.kind === "pr"
            ? await createPullRequestWorkTree({
                repo: prepared.repo,
                base: prepared.base,
                workTree: workTreePath,
                branch: loop.branch,
                head: loop.head,
                foreign: loop.foreign === true,
                number: item.number,
              })
            : await createWorkTree({
                repo: prepared.repo,
                base: prepared.base,
                workTree: workTreePath,
                branch: loop.branch,
              });
      }
    } catch (err) {
      if (PR_BRANCH_REFUSALS.has(err?.code)) {
        await skipLoop(issue, {
          skipReason: err.code,
          reason: err.message,
          extra: { workTree: null, remainingSteps: loop.remainingSteps },
          release: true,
        });
        return null;
      }
      await changeLoop(issue, {
        status: "failed",
        reason: `work-tree-failed: ${err.message}`,
        workTree: null,
      });
      await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId });
      logError(`issue ${issue}: failed (work-tree-failed: ${err.message})`);
      return null;
    }
    loop = { ...loop, task, workTree };
    const continuation = loop.decisionAnswer != null;
    let freshRecovery = { continueFrom: null, pr: null };
    if (recordedWorkTree !== null && recordedWorkTree !== undefined) {
      const refused = await verifyWorkTree(loop);
      if (refused !== null) {
        await markNeedsOwner(issue, refused, {
          evidence: refused,
          extra: { prUndeclared: loop.prUndeclared ?? null },
        });
        return null;
      }
      if (!continuation) {
        const decision = await reconcile({
          loop,
          repo: prepared.repo,
          base: prepared.base,
          gh,
          deps,
        });
        if (decision.status === "succeeded") {
          await finishSuccess(issue, loop, {
            stepsUsed: loop.stepsUsed,
            remainingSteps: loop.remainingSteps,
            pr: decision.pr ?? loop.pr,
          });
          return null;
        }
        if (decision.status === "needs-owner") {
          await markNeedsOwner(issue, decision.reason, {
            evidence: decision.reason,
            extra: { prUndeclared: loop.prUndeclared ?? null },
          });
          return null;
        }
        const continueFrom = loop.attempts > 0 ? loop.transcript : null;
        freshRecovery = { continueFrom, pr: decision.pr ?? loop.pr };
      }
    }
    await changeLoop(issue, {
      workTree,
      task,
      status: "queued",
      setupDone: loop.setupDone === true,
      pr: freshRecovery.pr ?? loop.pr,
      ...clearUndeclared(freshRecovery.pr ?? loop.pr),
    });
    return { loop, continuation, freshRecovery };
  };

  // The start step continues a transcript, runs the setup, or spawns the child.
  const launchStart = async (issue, { loop, continuation, freshRecovery, recovery }) => {
    if (recovery !== null) {
      if (isStopped()) return;
      await changeLoop(issue, { attempts: loop.attempts + 1 });
      loop = loops.get(issue);
      return startChild(issue, loop, { resume: recovery });
    }
    if (continuation) {
      await continueLoop(issue, loop);
      return;
    }
    if (prepared.setupCmd && loop.setupDone !== true) {
      const ok = await runSetup({
        command: prepared.setupCmd,
        workTree: loop.workTree.path,
        timeoutSeconds: prepared.setupTimeout,
        signal,
        deps,
      });
      if (!ok && isStopped()) return;
      if (!ok) {
        await changeLoop(issue, { status: "failed", reason: "setup-failed" });
        await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId });
        logError(`issue ${issue}: failed (setup-failed)`);
        return;
      }
      await changeLoop(issue, { setupDone: true });
    }
    if (isStopped()) return;
    await changeLoop(issue, { attempts: loop.attempts + 1 });
    loop = loops.get(issue);
    return startChild(issue, loop, { resume: freshRecovery });
  };

  const launchIssue = async (issue, { recovery = null } = {}) => {
    let loop = loops.get(issue);
    const item = {
      kind: loop.kind ?? "issue",
      key: loop.issue,
      number: loop.number ?? (typeof loop.issue === "number" ? loop.issue : null),
      text: loop.text ?? null,
      mode: loop.mode ?? "work-first",
      task: loop.taskOverride ?? null,
      head: loop.head ?? null,
      headRefName: loop.headRefName ?? null,
      foreign: loop.foreign === true,
    };
    if (recovery === null) {
      const eligibility = await launchEligibility(issue, { item, loop });
      if (eligibility === null) return;
      if (!(await launchClaim(issue, { claim: eligibility.claim }))) return;
      const launched = await launchWorkTree(issue, {
        item,
        loop,
        itemTitle: eligibility.itemTitle,
      });
      if (launched === null) return;
      loop = launched.loop;
      return launchStart(issue, {
        loop,
        continuation: launched.continuation,
        freshRecovery: launched.freshRecovery,
        recovery: null,
      });
    }
    return launchStart(issue, { loop, continuation: false, freshRecovery: null, recovery });
  };

  const startChild = async (issue, loop, { resume }) => {
    if (isStopped()) return;
    const attempt = loop.attempts;
    const logPath = paths.log(batchId, issue, attempt);
    const args = childArguments({
      prepared,
      loop,
      workTree: loop.workTree.path,
      transcript: loop.transcript,
      maxSteps: loop.remainingSteps,
      resume,
    });
    await changeLoop(issue, {
      status: "running",
      skipReason: null,
      reason: null,
      log: logPath,
      pid: null,
      startTime: null,
      decisionAnswer: null,
    });
    let child;
    try {
      child = await spawnHeadless({
        args,
        cwd: loop.workTree.path,
        logPath,
        deps,
      });
    } catch (err) {
      const text = spawnFailureText(err);
      await changeLoop(issue, {
        status: "failed",
        reason: `child-error: ${text}`,
      });
      await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId });
      logError(`issue ${issue}: failed (child-error: ${text})`);
      return;
    }
    children.set(issue, child);
    slots.add(issue);
    if (isStopped()) child.kill?.("SIGINT");
    await changeLoop(issue, { pid: child.pid ?? null, startTime: child.startTime ?? null });
    progress(`issue ${issue}: attempt ${attempt} started (pid ${child.pid ?? "unknown"})`);
    const promise = (async () => {
      await settleChild(issue, child, () => isStopped());
    })();
    active.set(issue, promise);
    // Both handlers keep the settle chain handled, and a failed checkpoint write is logged.
    promise.then(
      () => active.delete(issue),
      (err) => {
        active.delete(issue);
        logError(`the child settle failed: ${err?.message ?? err}`);
      },
    );
  };

  return { launchIssue };
}
