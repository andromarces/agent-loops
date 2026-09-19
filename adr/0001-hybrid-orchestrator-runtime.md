# 0001. Hybrid orchestrator with deterministic runtime

## Status

accepted

## Date

2026-09-19

## Context

The initial `agent-loops` design used a rigid sequential worker-first loop gated by an exact `REVIEW_COMPLETE` string marker. In practice, this fixed loop proved inflexible: the worker was forced to run first even when inspection was desired first, reviewer feedback could not be evaluated or rejected by an overseer, and child CLI loops suffered from loop-termination ambiguity.

We need a flexible orchestration architecture where an LLM orchestrator directs the task by choosing discrete actions, while a deterministic Node.js controller enforces safety invariants, step budgets, and process lifecycles.

## Decision

We adopt a hybrid orchestrator model with a deterministic runtime:

1. **Role separation**:
   - `orchestrator`: Decides the next action (`run_worker`, `run_reviewer`, `finish`, `abort`) via structured JSON output. It does not modify files or spawn subprocesses.
   - `worker`: Implements code changes and runs checks.
   - `reviewer`: Inspects and verifies changes in read-only mode.
2. **Deterministic controller**:
   - Manages process spawning, session resumption, step limits (`--max-steps`, default 20), timeouts, and signal cancellation (`SIGINT`).
   - Enforces read-only safety for reviewer and orchestrator turns using CLI sandbox/plan flags and pre/post Git work-tree mutation detection.
   - Executes exactly one repair turn if the orchestrator returns malformed or invalid action JSON.
3. **Structured summary**:
   - A task completes successfully only when the orchestrator returns `finish` with a complete 5-section summary (`changed`, `verified`, `deferred`, `notDone`, `open`).

## Consequences

- The fixed worker-first loop, `--max-reviews`, and `REVIEW_COMPLETE` marker are removed.
- Reviewer and orchestrator turns are strictly non-mutating; any detected mutation halts the run immediately with an exit code of 1 and leaves modified paths intact without automatic revert.
- Step limits and repair limits are hard-coded constraints enforced by Node.js that the LLM cannot override.
- Transcripts can be captured deterministically to JSON via `--transcript`.

## Alternatives

1. **Extend the fixed loop with conditional branches**: Adds complex heuristic edge cases and does not solve dynamic workflow needs.
2. **Ordered multi-role pipeline with string gate markers**: Still relies on fragile text markers and cannot adaptively skip, repeat, or branch roles.
3. **Orchestrator shells out directly**: Gives unrestricted subshell execution to the orchestrator model, bypassing host budget and mutation safety controls.

## Authors

Andro Marces

## Links

- [Issue #14: Hybrid orchestrator and deterministic runtime](https://github.com/andromarces/agent-loops/issues/14)
- [ADR Index](README.md)
