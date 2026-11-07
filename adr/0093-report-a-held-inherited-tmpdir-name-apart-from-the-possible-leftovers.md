# 0093. Report a held inherited temporary directory name apart from the possible leftovers

## Status

superseded

Partially supersedes [ADR 0081](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md) and [ADR 0082](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md). The `Supersedes` section names each replaced part.

Superseded by [ADR 0095: Report inherited temporary directory names as diagnostics, not open items](0095-report-inherited-tmpdir-names-as-diagnostics-not-open-items.md):

- Decisions 1 to 10 and every consequence. The settled field and the Windows and macOS ownership probes are removed.

No decision remains in force.

## Supersedes

- The single present list of decision 2 in [ADR 0081](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md). Replaced by the present list and the settled list.
- The rule of decision 2 that the re-check follows no link, for the Windows probe. Replaced by the `lstat` and handle-identity rule.
- The rule of decision 6 in [ADR 0081](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md) that a recorded name never resolves a path. Replaced for the probe by the regular-file `lstat` and handle-identity check.
- The single last-read report of decision 2 in [ADR 0082](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md). Replaced by the present list and the settled list.

## Date

2026-11-07

## Context

A GUID `.tmp` file that another live process holds open outlives the three-minute wait of ADR 0082. The re-check then reports it as a possible run leftover, and the parent carries it into `open` (issue #1600).

On Windows, a delete of that file failed with `Device or resource busy` after the run ended. On macOS, `lsof` showed no holder for a `<GUID>-<pid>-<hex>-shm` and `-wal` pair. The embedded pid named a live system process outside the run.

A name that a probe settles needs its own field. A name that the probe cannot settle stays reported, so no name drops silently.

## Decision

1. **Add a settled field.** The `role recheck-tmpdir` envelope carries `inheritedTmpdirSettled` when at least one name is settled. The field is redacted and capped at 20 like `inheritedTmpdirEntries`. `inheritedTmpdirEntries` keeps only the names that stay possible run leftovers.
2. **Probe Windows files read-only.** Each remaining regular file gets a read-only open with the libuv `UV_FS_O_EXLOCK` value, `0x10000000`. `EBUSY` settles the name as held open by another process. A directory, a link, any other error, or the probe bound keeps the name reported.
3. **Compare the opened handle.** The Windows probe reads the path with `lstat` first. A link, a directory, or an `lstat` error keeps the name reported. It opens a regular file read-only.
4. **Keep a free file reported.** Only an `EBUSY` from that open settles the name. When the open succeeds, it compares the device and inode of the handle with the `lstat` result. A match means that no other process holds the file, so the name stays reported. A mismatch, an `fstat` error, and every other open error keep the name.
5. **Use the libuv value.** Node exposes no `fs.constants.UV_FS_O_EXLOCK` entry in the supported releases. The check covered Node 22, 24, and 26. A Windows test proves that the value reports `EBUSY` while another handle holds the file.
6. **Settle by the embedded pid.** The name must match a canonical UUID, a pid, a hex run, and the `-shm` or `-wal` suffix. Both pair members must be regular files by `lstat`. The pid must be alive through signal 0 or `EPERM`. The ancestor set includes every ancestor up to PID 1. The recheck process and its ancestors never settle.
7. **Keep the macOS limit.** A live process with that pid can be unrelated to the file. A lone member, a malformed pid, a non-regular entry, and an unreadable ancestry keep the name reported. A failed or bounded ancestry read keeps every name reported.
8. **Keep the current behavior elsewhere.** Linux settles no name. Any name that a probe cannot settle stays in `inheritedTmpdirEntries`.
9. **Bound and close.** The probes run inside the re-check settle bound. A failed or over-bound probe keeps its name. The probe opens no file for writing, creates nothing, deletes nothing, and closes every handle on every path.
10. **Keep the headless path in parity.** A headless result carries the possible leftovers in `inheritedTmpdirPresent` and the settled names in `inheritedTmpdirSettled`. The parent carries only `inheritedTmpdirEntries` or `inheritedTmpdirPresent` into `open`.

## Consequences

- A held-open GUID `.tmp` file no longer reaches `open` as a possible run leftover.
- A file that no process holds open stays reported.
- A settled name stays visible in its own envelope field, so no name drops silently.
- A macOS pair whose embedded pid is dead, malformed, or not a regular file stays reported.
- A Windows `lstat` or `fstat` error stays reported, and only an `EBUSY` from the open settles.
- The Windows probe denies sharing for the instant of the open, and it reads no byte. A concurrent open or delete of that file can fail with `EBUSY`.
- A probe that fails or reaches its bound changes no report.

## Alternatives

1. **Use `fs.constants.UV_FS_O_EXLOCK` directly.** Not taken. Node 22, 24, and 26 expose no such constant, and the value `0x10000000` is the libuv flag.
2. **Settle a macOS pair by an absent main database file.** Not taken. The pair can be a run leftover with no holder, and acceptance item 2 keeps that name reported.
3. **Leave a settled name out with no field.** Not taken. The parent then loses the name without a record.

## Authors

Andro Marces

## Links

- [Issue #1600](https://github.com/andromarces/agent-loops/issues/1600)
- [PR #1609](https://github.com/andromarces/agent-loops/pull/1609)
- [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md)
- [ADR 0082: Wait for a reported inherited temporary directory name to vanish](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md)
- Implementation:
  - Probe and classification: `settleInheritedTmpdirNames` in `src/lib/tmpdir-entries.mjs`
  - Parent read: `recheck-tmpdir` in `src/role/index.mjs`
  - Headless prompt: `inheritedTmpdirSettled` in `src/runtime.mjs` and `src/prompts/orchestrator.mjs`
  - Docs: `docs/reference/role.md` and `docs/orchestrator/runtime-advisory-fields.md`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`, `tests/role.recheck-tmpdir.test.mjs`, and `tests/runtime.inherited-tmpdir.test.mjs`
- [ADR Index](README.md)
