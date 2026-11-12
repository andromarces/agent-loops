// The `batch status` read: one stored batch as a status view with its decisions and next action.
import { ownerAlive } from "../lib/process-identity.mjs";
import { readAnswer, readDecision } from "./decisions.mjs";
import { batchPaths, readLoop, readManifest } from "./store.mjs";
import { loopEntry, queuedLoop } from "./loop-records.mjs";

async function decisionView(runsRoot, batchId, loop) {
  if (typeof loop.decision !== "string") return null;
  const read = await readDecision(runsRoot, batchId, loop.decision);
  if (read === null) {
    return { id: loop.decision, state: "malformed", error: "the decision file is missing" };
  }
  if (!read.ok) {
    return { id: loop.decision, state: "malformed", error: read.reason };
  }
  const { decision } = read;
  const view = {
    id: decision.id,
    state: "pending",
    reason: decision.reason,
    evidence: decision.evidence,
    options: decision.options.map((option) => option.key),
    recommended: decision.recommended,
    answer: null,
  };
  const answer = await readAnswer(
    runsRoot,
    batchId,
    loop.decision,
    decision.options.map((option) => option.key),
    loop.issue,
  );
  if (answer !== null && !answer.ok) {
    return { ...view, state: "malformed", error: answer.reason };
  }
  if (answer !== null) {
    return { ...view, state: "answered", answer: { option: answer.answer.option } };
  }
  return view;
}

/** The next action of a loop that needs its owner, or null when no named action exists. */
function nextActionOf(loop) {
  if (loop.status !== "needs-owner" || loop.reason !== "pr-head-unresolved") return null;
  if (loop.pr == null) {
    return `compare branch ${loop.branch} with the reviewed commit, then merge or resume. The pull request number is not recorded`;
  }
  return `compare pull request ${loop.pr} head with the reviewed commit, then merge or resume`;
}

/** Reads one batch for `batch status`. A live-owner checkpoint that is gone reads `stale`. */
export async function readBatchStatus({ runsRoot, id }) {
  const manifest = await readManifest(runsRoot, id);
  if (manifest === null) throw Object.assign(new Error(`No batch ${id}.`), { usage: true });
  const loops = [];
  const skipped = new Map((manifest.skipped ?? []).map((loop) => [loop.key, loop]));
  const keys = Array.isArray(manifest.items)
    ? manifest.items.map((item) => item.key)
    : manifest.issues;
  const runnable = new Set(manifest.issues);
  for (const issue of keys) {
    if (!runnable.has(issue)) {
      const skippedLoop = skipped.get(issue);
      if (skippedLoop === undefined) continue;
      loops.push({
        ...loopEntry(skippedLoop),
        decision: null,
        blockingIssues: [],
        requiredMerges: [],
        nextAction: null,
      });
      continue;
    }
    const loop = await readLoop(runsRoot, id, issue);
    if (loop === null) {
      const item = (manifest.items ?? []).find((entry) => entry.key === issue);
      if (item === undefined) continue;
      loops.push({
        ...loopEntry(queuedLoop(batchPaths(runsRoot), id, item, manifest.settings?.maxSteps ?? 0)),
        decision: null,
        blockingIssues: [],
        requiredMerges: [],
        nextAction: "batch resume",
      });
      continue;
    }
    const waitDetails = {
      decision: await decisionView(runsRoot, id, loop),
      blockingIssues: Array.isArray(loop.blockingIssues) ? loop.blockingIssues : [],
      requiredMerges: loop.status === "waiting" ? (loop.blockingIssues ?? []) : [],
    };
    if (loop.status === "running" && loop.pid != null) {
      const live = await ownerAlive({ pid: loop.pid, startTime: loop.startTime });
      loops.push({
        ...loopEntry(loop),
        ...waitDetails,
        status: live ? "running" : "stale",
        nextAction: live ? null : "batch resume",
      });
    } else loops.push({ ...loopEntry(loop), ...waitDetails, nextAction: nextActionOf(loop) });
  }
  return {
    ...manifest,
    completion: {
      status: manifest.status,
      complete: ["completed", "failed"].includes(manifest.status),
    },
    loops,
  };
}
