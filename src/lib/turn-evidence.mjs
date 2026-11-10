import { entryCarrier } from "./entry-report.mjs";
import { readProp } from "./error-message.mjs";

// The evidence fields of a turn result, in both the ok and the error envelope, the result prompt,
// and the fatal-path events. A consumer of `TURN_EVIDENCE_FIELDS` picks up a new field with no change.
// A new field needs one entry here, and its producer in `runChild`.
// - sharedGitChanged: names of the shared Git items the worker turn changed outside the work tree
//   (issue #984).
// - mainWorkTreeChanged: paths of the main work tree that a worker turn in a linked work tree changed
//   (issue #1448).
// - mainWorkTreeChangedInTurn: paths of the main work tree that changed and were restored inside a
//   worker turn window (issue #1556).
// - mainWorkTreeFastForward: the old and new head of a clean fast-forward to the remote default
//   branch (issue #1485).
// - localSourceChangedInTurn: paths of the copied local sources that changed inside a worker or
//   reviewer turn window (issue #1504).
// - lockfileChanged: paths of the dependency files the worker turn changed. Before the next
//   reviewer turn, the parent runs only the dependency setup that the repository documents for
//   its tests in the work tree, and a changed dependency file that no test setup reads needs no
//   action (issues #1180 and #1537).
// - inheritedTmpdirEntries: names that appeared in the inherited temporary directory during a
//   reviewer turn, or in a literal system temporary directory that differs from it during any
//   child turn. One post-turn read lists them, with no settle re-read, and a failed read gives
//   none. Diagnostic: the runtime cannot attribute them to the turn, and they create no automatic
//   open item (issue #1024, issue #1616, issue #1713, ADR 0095, ADR 0108).
// - packageStoreEntries: names that changed in the pnpm package store during a reviewer turn.
//   Advisory, like the temporary directory entries (issue #1045).
// - testRun: the test command result the runtime ran before a reviewer turn (ADR 0017), for the
//   comparison with the Checks line. The state file keeps it beside the response in `lastResult`,
//   and the turn history keeps its fixed shape.
// Each entry also names the type and the value property of the fatal-path event of its field.
const localSourceCarrier = entryCarrier("localSourceChangedInTurn");
const sharedGitCarrier = entryCarrier("sharedGitChanged");
const mainWorkTreeCarrier = entryCarrier("mainWorkTreeChanged");
const mainWorkTreeInTurnCarrier = entryCarrier("mainWorkTreeChangedInTurn");
const mainWorkTreeFastForwardCarrier = entryCarrier("mainWorkTreeFastForward");
const lockfileCarrier = entryCarrier("lockfileChanged");
const inheritedTmpdirCarrier = entryCarrier("inheritedTmpdirEntries");
const packageStoreCarrier = entryCarrier("packageStoreEntries");
const testRunCarrier = entryCarrier("testRun");
// A canceled test command sets the result directly, which `carry` never recorded.
const failedTestRun = (err) => testRunCarrier.failed(err) ?? readProp(err, "testRun");
const TURN_EVIDENCE = [
  {
    field: "sharedGitChanged",
    type: "shared-git",
    key: "items",
    carry: sharedGitCarrier.carry,
    failed: sharedGitCarrier.failed,
  },
  {
    field: "mainWorkTreeChanged",
    type: "main-work-tree",
    key: "paths",
    carry: mainWorkTreeCarrier.carry,
    failed: mainWorkTreeCarrier.failed,
  },
  {
    field: "mainWorkTreeChangedInTurn",
    type: "main-work-tree-in-turn",
    key: "paths",
    carry: mainWorkTreeInTurnCarrier.carry,
    failed: mainWorkTreeInTurnCarrier.failed,
  },
  {
    field: "mainWorkTreeFastForward",
    type: "main-work-tree-fast-forward",
    key: "heads",
    carry: mainWorkTreeFastForwardCarrier.carry,
    failed: mainWorkTreeFastForwardCarrier.failed,
  },
  {
    field: "localSourceChangedInTurn",
    type: "local-source-change",
    key: "paths",
    carry: localSourceCarrier.carry,
    failed: localSourceCarrier.failed,
  },
  {
    field: "lockfileChanged",
    type: "lockfile",
    key: "paths",
    carry: lockfileCarrier.carry,
    failed: lockfileCarrier.failed,
  },
  {
    field: "inheritedTmpdirEntries",
    type: "inherited-tmpdir",
    key: "entries",
    carry: inheritedTmpdirCarrier.carry,
    failed: inheritedTmpdirCarrier.failed,
  },
  {
    field: "packageStoreEntries",
    type: "package-store",
    key: "entries",
    carry: packageStoreCarrier.carry,
    failed: packageStoreCarrier.failed,
  },
  {
    field: "testRun",
    type: "test-run",
    key: "testRun",
    emitFirst: true,
    carry: testRunCarrier.carry,
    failed: failedTestRun,
  },
];

export const TURN_EVIDENCE_FIELDS = TURN_EVIDENCE.map(({ field }) => field);

/**
 * The event that the fatal path of `runLoop` emits for each evidence field, with the event
 * property that carries the value. The `testRun` event comes first, then the others in field order.
 */
export const TURN_EVIDENCE_EVENTS = [
  ...TURN_EVIDENCE.filter((entry) => entry.emitFirst),
  ...TURN_EVIDENCE.filter((entry) => !entry.emitFirst),
];

const carriesValue = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));

/**
 * Builds the common turn-result fields of `source` that carry a value, in `order`.
 * `order` keeps the JSON key order of the caller. A falsy field and an empty list are dropped.
 * `shellDenied` is normalized to `true`.
 * @param {object} source
 * @param {string[]} order
 * @returns {object}
 */
export function turnResultFields(source, order) {
  return Object.fromEntries(
    order
      .filter((field) => carriesValue(source[field]))
      .map((field) => [field, field === "shellDenied" ? true : source[field]]),
  );
}

/** Picks the evidence fields of `source` that carry a value. A falsy field and an empty list are dropped. */
export function pickTurnEvidence(source) {
  return turnResultFields(source, TURN_EVIDENCE_FIELDS);
}

/**
 * Carries the evidence of a failed turn on a fatal error. The evidence is the `--test-cmd` result,
 * the shared Git items, the main work tree paths, the lockfile paths, and the two advisory lists.
 * An absent or empty field is skipped, and so is an error that cannot take it.
 */
export function carryTurnEvidence(err, evidence) {
  if (!err || typeof err !== "object") return;
  for (const { field, carry } of TURN_EVIDENCE) {
    if (carriesValue(evidence[field])) carry(err, evidence[field]);
  }
}

/** Reads back what `carryTurnEvidence` carried. A field the error does not carry is `undefined`. */
export function failedTurnEvidence(err) {
  return Object.fromEntries(TURN_EVIDENCE.map(({ field, failed }) => [field, failed(err)]));
}

/** @typedef {{ sharedGitChanged?: string[], mainWorkTreeChanged?: string[], mainWorkTreeChangedInTurn?: string[], mainWorkTreeFastForward?: { before: string, after: string }, localSourceChangedInTurn?: string[], lockfileChanged?: string[], inheritedTmpdirEntries?: string[], packageStoreEntries?: string[], testRun?: object }} TurnEvidence */
