# 0046. Default the test slot count to one

## Status

accepted

Partially supersedes [ADR 0039: Gate full-suite test runs with a machine-wide test slot](0039-machine-wide-test-slot.md). This ADR replaces decision 3 (the default count). Every other decision of ADR 0039 holds.

## Date

2026-10-18

## Context

ADR 0039 set the default slot count to `max(1, floor(os.availableParallelism() / 8))`: 1 slot on 8 CPUs, 2 slots on 16 CPUs. Issue #926 records two measurements. Neither was run for this change.

- **#921 experiment**, a simulation of the agent-loop load on an 8-CPU host. With 2 slots, 2 of 16 full suites had a 15 s test timeout. With 1 slot, 0 of 16 failed. A direct targeted run was active in both arms.
- **2026-10-18 run**, at `main` `0746195` on a 16-CPU Windows host with the default of 2 slots, 2 concurrent full suites, and no direct targeted run. All 16 suites failed. Each had 19 to 30 failures, and 15 to 26 of them were 15 s timeouts. Other host processes were not controlled.

No measurement ran 1 slot on a 16-CPU host. The #921 result supports the slot-holder overlap cause but does not prove it.

## Decision

1. **Default 1.** `testSlotOptions` returns 1 slot when neither `--slots` nor `AGENT_LOOP_TEST_SLOTS` is set, on every CPU count.
2. **Reason.** 1 is the only count with a clean result (0 of 16 suites failed). 2 slots failed in both measurements, and it failed worse on the 16-CPU host. Full suites on a host are then serial, and a host that tolerates more can set `AGENT_LOOP_TEST_SLOTS`.
3. **Unchanged.** The overrides, the wait bound, the `--if-held` rule of ADR 0044, and the 15 s `testTimeout` in `vite.config.mjs`.

## Consequences

- Concurrent full suites on one host run one after the other. A suite takes 308 to 343 s on the 16-CPU host, so a second waiting wrapper can wait about that long, inside the 1800 s wait bound.
- The decision rests on the recorded measurements only. A run of 1 slot on a 16-CPU host would confirm it, and a result that shows 2 slots clean there would reopen the count.
- A targeted run through `--if-held` still holds no slot while all slots are free (ADR 0044), so overlap with a slot holder is still possible and is not measured here.
- The `AGENT_LOOP_TEST_SLOTS=2` setting that the baseline arm of #921 used must now be set by hand to reproduce it.

## Alternatives

1. **Keep `max(1, floor(CPUs / 8))`.** Not taken. It gave 2 slots on a 16-CPU host, where all 16 suites failed, and 2 slots on the 8-CPU host also produced timeouts.
2. **Raise the CPU divisor, for example `floor(CPUs / 16)`.** Not taken. It would give 1 slot only up to 31 CPUs, and no measurement covers a larger host.
3. **Raise `testTimeout` above 15 s.** Not taken. It hides the overload, and 30 s timeouts already occurred on the 16-CPU host.

## Authors

Andro Marces

## Links

- [Issue #926](https://github.com/andromarces/agent-loops/issues/926)
- [PR #938](https://github.com/andromarces/agent-loops/pull/938)
- [Issue #921](https://github.com/andromarces/agent-loops/issues/921)
- Partially supersedes [ADR 0039](0039-machine-wide-test-slot.md)
- [ADR 0044](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md)
- Implementation:
  - Source: `testSlotOptions` and `TEST_SLOT_HELP` in `src/lib/test-slot.mjs`, `src/cli.mjs`
  - Tests: `tests/lib/test-slot.test.mjs`
  - Docs: `docs/reference/usage.md`
- [ADR Index](README.md)
