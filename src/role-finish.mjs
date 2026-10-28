// `agent-loop role finish`: the finish gate. Validates the summary, applies the `--require-accept`,
// `--require-ci`, and `--compare-head` gates, and ends an active run as `finished`.
import { REVIEW_ONLY_COMPARE_HEAD_REFUSAL, REVIEW_ONLY_GATE_REFUSAL } from "./lib/args.mjs";
import {
  checkCi,
  checkPrHead,
  compareHeadConflict,
  missingGateRefusal,
  unresolvedCompareReason,
} from "./lib/ci-gate.mjs";
import { isJsonObject } from "./lib/json.mjs";
import { logInfo } from "./lib/log.mjs";
import { acceptanceFailure } from "./lib/report.mjs";
import { writeState } from "./lib/runstate.mjs";
import { reviewedState, snapshot } from "./lib/snapshot.mjs";
import { validateAction } from "./contracts/orchestrator-action.mjs";
import { RoleError } from "./role-envelope.mjs";

// V8 `JSON.parse` message heads that carry no input text, observed on Node 26 (#839).
const JSON_POSITION_PHRASES = [
  "Bad escaped character",
  "Bad control character in string literal",
  "Bad Unicode escape",
  "Unterminated string",
  "Expected property name or '}'",
  "Expected double-quoted property name",
  "Expected ',' or '}' after property value",
  "Expected ',' or ']' after array element",
  "Expected ':' after property name",
  "Unexpected non-whitespace character after JSON",
  "No number after minus sign",
  "Unterminated fractional number",
  "Exponent part is missing a number",
  "Unexpected number",
];
const JSON_POSITION_TAIL = /^(?: in JSON)? at position (\d+)(?: \(line (\d+) column (\d+)\))?$/;

/**
 * Names a `JSON.parse` failure without copying the summary text. The V8 message can quote
 * the input, so the result is built only from the fixed phrases above plus the numeric
 * position; any other message yields the generic `not valid JSON`.
 */
function describeJsonParseError(error) {
  const message = String(error?.message);
  if (message === "Unexpected end of JSON input") {
    return message;
  }
  for (const phrase of JSON_POSITION_PHRASES) {
    const tail =
      message.startsWith(phrase) && JSON_POSITION_TAIL.exec(message.slice(phrase.length));
    if (tail) {
      return `${phrase} at position ${tail[1]}${tail[2] ? ` (line ${tail[2]} column ${tail[3]})` : ""}`;
    }
  }
  if (message.startsWith("Unexpected token ")) {
    return "Unexpected token";
  }
  const where = /in JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(message);
  return where
    ? `not valid JSON at position ${where[1]}${where[2] ? ` (line ${where[2]} column ${where[3]})` : ""}`
    : "not valid JSON";
}

/**
 * `finish`: accepts the five-key summary as JSON on stdin, from active only, and
 * sets the lifecycle to `finished`. A key other than the five and
 * `unresolvedCompare` is refused and named (#1021).
 * `--compare-head <pr>` makes the PR-head half of the gate and nothing else: it refuses unless the
 * PR is open, its head equals `reviewed.head`, and the reviewed tree is clean, reads no required-check source, evaluates no
 * merge state, and records `headCompare: "verified"` in the envelope and the state file. It is refused beside
 * `--require-ci` and `unresolvedCompare`, and a declared-PR run still needs its gate (#1098).
 * `--require-accept` and `--require-ci` gate the finish. Every applicable refusal
 * is reported in one error. A run that declared `--pr <pr>` at init must end
 * through `--require-ci <pr>`: a finish with no gate or a gate for another PR is
 * refused. A finish that carries `unresolvedCompare` is refused under
 * `--require-ci` and for a declared PR, because the gate resolves the compare.
 * An optional `unresolvedCompare` boolean beside the five keys, and a gate that
 * passes with no required check (`noRequiredChecks`), are recorded in the
 * envelope and the state file. Both keep the finish distinct from a verified
 * one. Without `--require-ci` or `--compare-head` this subcommand never resolves
 * the PR head, so an omitted marker is an accepted gap (ADR 0009, ADR 0012,
 * issues #281, #286, #293, #302, #336).
 */
export async function finishRun(args, state, paths, { stdin, gh, signal }) {
  if (state.lifecycle !== "active") {
    throw new RoleError(`finish is accepted only from active; run is ${state.lifecycle}.`);
  }

  if ((args.requireAccept || args.requireCi !== null) && state.mode === "review-only") {
    throw new RoleError(REVIEW_ONLY_GATE_REFUSAL);
  }
  if (args.compareHead !== null && state.mode === "review-only") {
    throw new RoleError(REVIEW_ONLY_COMPARE_HEAD_REFUSAL);
  }

  const text = await stdin();
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RoleError(
      `finish summary must be a JSON object on stdin: ${describeJsonParseError(error)}`,
    );
  }
  // The summary arrives unwrapped, so the marker the headless action carries
  // beside `summary` sits beside the five keys here. It moves out of the
  // summary so the validator keeps its own boolean check (#281) and refuses
  // every other unknown key (#1021).
  const action = { action: "finish", summary: value };
  if (isJsonObject(value) && value.unresolvedCompare !== undefined) {
    const { unresolvedCompare, ...summary } = value;
    action.summary = summary;
    action.unresolvedCompare = unresolvedCompare;
  }
  const validated = validateAction(action);
  if (!validated.ok) {
    throw new RoleError(validated.error);
  }
  // Refusals are collected in the headless order, minus the `review-only`
  // condition this path cannot reach. The gate runs only when nothing above
  // refused, so a refused finish never reads GitHub (#302).
  const refusals = [];
  // The headless gate refuses the same combination with the same words, so the
  // message is one function rather than two copies (#293).
  const markerReason = unresolvedCompareReason({
    pr: state.pr ?? null,
    requireCi: args.requireCi,
  });
  const markerRefused = markerReason !== null && validated.value.unresolvedCompare;
  if (markerRefused) {
    refusals.push(markerReason);
  }
  if (args.compareHead !== null) {
    const conflict = compareHeadConflict({
      requireCi: args.requireCi,
      unresolvedCompare: validated.value.unresolvedCompare === true,
    });
    if (conflict) {
      refusals.push(conflict);
    }
  }
  if (args.requireAccept) {
    const reason = await acceptGateReason(state, args.cwd, signal);
    if (reason) {
      refusals.push(reason);
    }
  }
  // The init-time `--pr` declaration is the run's PR input, so a declared run
  // can only end through the gate for that PR. A state file written before this
  // field has no `pr`, so an absent declaration keeps the marker-only behavior.
  const declaredPr = state.pr ?? null;
  if (declaredPr !== null && args.requireCi !== declaredPr) {
    refusals.push(missingGateRefusal(declaredPr, args.requireCi).reason);
  }
  if (refusals.length > 0) {
    // The marker contradiction against a gate was its own error text before
    // collect-then-report, and a run that declares no PR still returns that text
    // on its own, because it has the same single refusal it always had (#302).
    if (refusals.length === 1 && markerRefused && declaredPr === null) {
      throw new RoleError(`${markerReason}.`);
    }
    throw new RoleError(`Finish refused: ${refusals.join("; ")}.`);
  }
  let noRequiredChecks = false;
  if (args.requireCi !== null) {
    const gate = await checkCi({
      pr: args.requireCi,
      reviewed: state.lastResult?.reviewed ?? null,
      cwd: args.cwd,
      gh,
      signal,
    });
    if (!gate.ok) {
      throw new RoleError(`Finish refused: ${gate.reason}.`);
    }
    noRequiredChecks = gate.noRequiredChecks === true;
  }
  if (args.compareHead !== null) {
    const compare = await checkPrHead({
      pr: args.compareHead,
      reviewed: state.lastResult?.reviewed ?? null,
      cwd: args.cwd,
      gh,
    });
    if (!compare.ok) {
      throw new RoleError(`Finish refused: ${compare.reason}.`);
    }
  }

  state.lifecycle = "finished";
  state.summary = validated.value.summary;
  const payload = { status: "ok", lifecycle: "finished" };
  if (noRequiredChecks) {
    // A base branch with no required check leaves the gate verifying the PR
    // head, the clean reviewed tree, and the merge state only. The finish
    // records that, so a reader never reads it as a pass on a checked branch
    // (#336).
    state.noRequiredChecks = true;
    payload.noRequiredChecks = true;
    logInfo(
      "no required check exists for the base branch; the gate verified the PR head, the reviewed tree, and the merge state",
    );
  }
  if (args.compareHead !== null) {
    // The runtime resolved the PR head, which `unresolvedCompare` records as not done. No check
    // result is claimed, so a reader never reads this as a gated pass (#1098).
    state.headCompare = "verified";
    payload.headCompare = "verified";
    logInfo(
      `the PR head of PR ${args.compareHead} equals the reviewed commit; no required check was read`,
    );
  }
  if (validated.value.unresolvedCompare) {
    // Recorded in the envelope and beside the summary in the state file, so a
    // recorded unresolved compare never reads as a verified finish (#281). A
    // verified finish keeps the current envelope and state.
    state.unresolvedCompare = true;
    payload.unresolvedCompare = true;
  }
  await writeState(paths.stateFile, state);
  logInfo(`run finished (${state.stepsUsed} steps used)`);
  return { exitCode: 0, payload };
}

/**
 * `--require-accept`: the latest turn must be a reviewer `verdict: accept` of
 * the current exact state, and the accepted review must carry a Checks line.
 * The current snapshot is compared against the reviewed head and digest, so a
 * change to an uncommitted state at the same head is detected. Returns null
 * when the gate holds, or a reason that names the failing condition.
 */
async function acceptGateReason(state, cwd, signal) {
  const last = state.lastResult;
  if (!last || last.role !== "reviewer" || last.status !== "ok") {
    return "no reviewer turn after the latest worker turn";
  }
  const failure = acceptanceFailure(last.response);
  if (failure === "verdict") {
    return "the latest reviewer turn did not return Verdict: accept";
  }
  if (failure === "checks") {
    return "the accepted review has no Checks line";
  }
  if (!last.reviewed) {
    return "the reviewer turn carries no reviewed state";
  }
  if (!last.reviewed.exact) {
    return "the reviewed snapshot is not exact";
  }
  const current = reviewedState(await snapshot(cwd, { signal }));
  if (!current.exact) {
    return "the current snapshot is not exact";
  }
  if (current.head !== last.reviewed.head) {
    return "the work tree HEAD changed after the accepted review";
  }
  if (current.digest !== last.reviewed.digest) {
    return "the work tree changed after the accepted review";
  }
  return null;
}
