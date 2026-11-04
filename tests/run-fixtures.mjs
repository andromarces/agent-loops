/** The finish summary the gate tests send. */
export const SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };

/** A reviewer reply whose verdict accepts the reviewed state. */
export const REVIEW_ACCEPT = [
  "Conclusion: the state passes.",
  "Why: changes match the task.",
  "Blockers: none.",
  "Checks: npm test",
  "Verdict: accept",
].join("\n");

/** A reviewer reply whose verdict rejects the reviewed state. */
export const REVIEW_REJECT = [
  "Conclusion: the state fails.",
  "Why: the change is incomplete.",
  "Blockers: none.",
  "Verdict: reject",
].join("\n");

/** Role state for a run whose orchestrator, worker, and reviewer use the `orch`, `work`, and `rev` adapters. */
export function gateRoles() {
  return {
    orchestrator: { kind: "orch", sessionId: null },
    worker: { kind: "work", sessionId: null },
    reviewer: { kind: "rev", sessionId: null },
  };
}
