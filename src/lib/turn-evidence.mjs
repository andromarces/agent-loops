import { carryInheritedTmpdirEntries, failedInheritedTmpdirEntries } from "./tmpdir-entries.mjs";
import { carryPackageStoreEntries, failedPackageStoreEntries } from "./package-store-entries.mjs";
import { carryLockfileChanged, failedLockfileChanged } from "./lockfile-change.mjs";
import {
  carryMainWorkTreeChanged,
  carryMainWorkTreeFastForward,
  failedMainWorkTreeChanged,
  failedMainWorkTreeFastForward,
} from "./main-work-tree-change.mjs";
import { carrySharedGitChanged, failedSharedGitChanged } from "./shared-git.mjs";
import { carryTestRun, failedTestRun } from "./test-cmd.mjs";

// The evidence fields of a turn result, in both the ok and the error envelope, the result prompt,
// and the fatal-path events. A consumer of `TURN_EVIDENCE_FIELDS` picks up a new field with no change.
// A new field needs one entry here, and its producer in `runChild`.
// - sharedGitChanged: names of the shared Git items the worker turn changed outside the work tree
//   (issue #984).
// - mainWorkTreeChanged: paths of the main work tree that a worker turn in a linked work tree changed
//   (issue #1448).
// - mainWorkTreeFastForward: the old and new head of a clean fast-forward to the remote default
//   branch (issue #1485).
// - lockfileChanged: paths of the lockfiles the worker turn changed, so the parent reinstalls
//   before the next reviewer turn (issue #1180).
// - inheritedTmpdirEntries: names that appeared in the inherited temporary directory during a
//   reviewer turn. Advisory: the runtime cannot attribute them to the turn (issue #1024).
// - packageStoreEntries: names that changed in the pnpm package store during a reviewer turn.
//   Advisory, like the temporary directory entries (issue #1045).
// - testRun: the test command result the runtime ran before a reviewer turn (ADR 0017), for the
//   comparison with the Checks line. The state file keeps it beside the response in `lastResult`,
//   and the turn history keeps its fixed shape.
// Each entry also names the type and the value property of the fatal-path event of its field.
const TURN_EVIDENCE = [
  {
    field: "sharedGitChanged",
    type: "shared-git",
    key: "items",
    carry: carrySharedGitChanged,
    failed: failedSharedGitChanged,
  },
  {
    field: "mainWorkTreeChanged",
    type: "main-work-tree",
    key: "paths",
    carry: carryMainWorkTreeChanged,
    failed: failedMainWorkTreeChanged,
  },
  {
    field: "mainWorkTreeFastForward",
    type: "main-work-tree-fast-forward",
    key: "heads",
    carry: carryMainWorkTreeFastForward,
    failed: failedMainWorkTreeFastForward,
  },
  {
    field: "lockfileChanged",
    type: "lockfile",
    key: "paths",
    carry: carryLockfileChanged,
    failed: failedLockfileChanged,
  },
  {
    field: "inheritedTmpdirEntries",
    type: "inherited-tmpdir",
    key: "entries",
    carry: carryInheritedTmpdirEntries,
    failed: failedInheritedTmpdirEntries,
  },
  {
    field: "packageStoreEntries",
    type: "package-store",
    key: "entries",
    carry: carryPackageStoreEntries,
    failed: failedPackageStoreEntries,
  },
  {
    field: "testRun",
    type: "test-run",
    key: "testRun",
    emitFirst: true,
    carry: carryTestRun,
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

/** @typedef {{ sharedGitChanged?: string[], mainWorkTreeChanged?: string[], mainWorkTreeFastForward?: { before: string, after: string }, lockfileChanged?: string[], inheritedTmpdirEntries?: string[], packageStoreEntries?: string[], testRun?: object }} TurnEvidence */
