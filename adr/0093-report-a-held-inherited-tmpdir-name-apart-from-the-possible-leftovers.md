# 0093. Report a held inherited temporary directory name apart from the possible leftovers

## Status

accepted

Partially supersedes [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md). It replaces decision 2's single present list with a present list and a settled list. It also replaces [ADR 0082: Wait for a reported inherited temporary directory name to vanish](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md) decision 2's single last-read report. Every other decision of ADR 0081 and ADR 0082 remains in force.

## Date

2026-11-07

## Context

A GUID `.tmp` file that another live process holds open outlives the three-minute wait of ADR 0082. The re-check then reports it as a possible run leftover, and the parent carries it into `open` (issue #1600).

On Windows, a delete of that file failed with `Device or resource busy` after the run ended. On macOS, `lsof` showed no holder for a `<GUID>-<pid>-<hex>-shm` and `-wal` pair. The embedded pid named a live system process outside the run.

A name that a probe settles needs its own field. A name that the probe cannot settle stays reported, so no name drops silently.

## Decision

1. **Add a settled field.** The `role recheck-tmpdir` envelope carries `inheritedTmpdirSettled` when at least one name is settled. The field is redacted and capped at 20 like `inheritedTmpdirEntries`. `inheritedTmpdirEntries` keeps only the names that stay possible run leftovers.
2. **Probe Windows files read-only.** Each remaining regular file gets a read-only open with libuv's `UV_FS_O_EXLOCK` value, `0x10000000`. `EBUSY` settles the name as held open by another process. A directory, a link, any other error, or the probe bound keeps the name reported.
3. **Use the libuv value.** Node exposes no `fs.constants.UV_FS_O_EXLOCK` entry in the supported releases. The check covered Node 22, 24, and 26. A Windows test proves that the value reports `EBUSY` while another handle holds the file.
4. **Choose the macOS pair rule.** An orphaned SQLite `-shm` and `-wal` pair settles both names when the main database file is absent from the directory. A pair whose main file is present stays reported, and so does a lone member.
5. **Keep the macOS limit.** The pair rule misses a held pair whose main database file stays in the directory. It needs no process liveness read, so it avoids PID reuse and ancestry questions.
6. **Keep the current behavior elsewhere.** Linux settles no name. Any name that a probe cannot settle stays in `inheritedTmpdirEntries`.
7. **Bound and close.** The probes run inside the re-check settle bound. A failed or over-bound probe keeps its name. The probe opens no file for writing, creates nothing, deletes nothing, and closes every handle on every path.
8. **Keep the headless path in parity.** A headless result carries the possible leftovers in `inheritedTmpdirPresent` and the settled names in `inheritedTmpdirSettled`. The parent carries only `inheritedTmpdirEntries` or `inheritedTmpdirPresent` into `open`.

## Consequences

- A held-open GUID `.tmp` file no longer reaches `open` as a possible run leftover.
- A file that no process holds open stays reported.
- A settled name stays visible in its own envelope field, so no name drops silently.
- A macOS pair whose main database file is present stays reported.
- The Windows probe denies sharing for the instant of the open, and it reads no byte.
- A probe that fails or reaches its bound changes no report.

## Alternatives

1. **Use `fs.constants.UV_FS_O_EXLOCK` directly.** Not taken. Node 22, 24, and 26 expose no such constant, and the value `0x10000000` is the libuv flag.
2. **Settle a macOS name by its embedded live PID.** Not taken. A live PID can belong to a process of the run, and PID reuse can settle a leftover.
3. **Leave a settled name out with no field.** Not taken. The parent then loses the name without a record.

## Authors

Andro Marces

## Links

- [Issue #1600](https://github.com/andromarces/agent-loops/issues/1600)
- [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md)
- [ADR 0082: Wait for a reported inherited temporary directory name to vanish](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md)
- Implementation:
  - Probe and classification: `settleInheritedTmpdirNames` in `src/lib/tmpdir-entries.mjs`
  - Parent read: `recheck-tmpdir` in `src/role/index.mjs`
  - Headless prompt: `inheritedTmpdirSettled` in `src/runtime.mjs` and `src/prompts/orchestrator.mjs`
  - Docs: `docs/reference/role.md` and `docs/orchestrator/runtime-advisory-fields.md`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`, `tests/role.recheck-tmpdir.test.mjs`, and `tests/prompts/orchestrator.test.mjs`
- [ADR Index](README.md)
