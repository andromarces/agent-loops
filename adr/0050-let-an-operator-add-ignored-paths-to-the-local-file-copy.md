# 0050. Let an operator add ignored paths to the local-file copy

## Status

accepted

Partially supersedes [ADR 0018: Copy untracked local files into a linked run work tree](0018-copy-local-files-into-a-linked-run-work-tree.md). This ADR replaces one sentence of decision 12: "The state file holds the boolean, not the names." The run state now also holds the operator paths. Every other decision of ADR 0018 holds.

## Date

2026-10-21

## Context

ADR 0018 copies a fixed list of ignored local files into a linked run work tree. A repository can keep other ignored reference data that a task needs, for example a downloaded API specification directory that the repository plans cite. A run work tree lacks it. Three of five workers reported the directory missing, and two fetched the specification from the network (issue #980).

ADR 0018 rejected a configurable path list as speculative. A real run now needs one, but the rejection holds for the fixed list and the size cap, which stay in code.

An operator path is input from outside the fixed list, so it reaches paths that the list never named: a tracked file, a path beyond a link, and a path that no ignore rule covers.

## Decision

1. **Flag.** `agent-loop role` takes the repeatable init flag `--copy-local-path <relative path>`. Each path joins the listed paths of ADR 0018 for that run. Every rule of ADR 0018 applies to the files under it: no replacement, no symlink followed, the size and entry bounds, and the three conditions. Copied names appear in `localFiles.copied` and `localFiles.skipped`. The headless `agent-loop` command takes no such flag.
2. **Syntax refusal.** The init refuses an empty path, an absolute or drive-qualified path, a path with a control character, a `.` or `..` segment, `.git` or a checkout under `.claude/worktrees`, a segment with a colon, and a segment that ends in a dot or a space. A trailing separator is dropped.
3. **Content refusal.** The init refuses a path when the main work tree holds a tracked file at or under it. Names compare folded, so a case alias of a tracked name is refused on any file system. The init also refuses a path when any level of it is a symlink or a junction, when the existing path does not resolve to the main work tree plus the path as written, when it is a registered work tree or holds a `.git` entry, and when any file under it that the copy would copy is not ignored in the receiving work tree. A path that does not exist passes, and a directory past the entry bound is skipped whole as before.
4. **Order.** Every refusal throws before any file is copied, before the state file is written, and before any child spawns, so no run is left to abort. The checks also run when `--cwd` is the main work tree and nothing would be copied. If the work tree path holds a control character and cannot be checked, the flag is refused.
5. **State.** The state file stores the sorted, normalized paths as `copyLocalPaths`, absent when the flag was not used. The copied names reach `localFilesCopied`, so `localFilesDiffer` covers them. A later call must repeat the same set or omit the flag.
6. **Opt-out.** `--copy-local-path` with `--no-copy-local-files` is refused.

## Consequences

- A child gets the ignored reference data that the task names, without a network fetch.
- A path that is not ignored fails the init instead of being skipped by name. The operator adds an ignore rule or drops the path.
- The folded compare refuses a path when its folded segments equal the folded leading segments of any one tracked name. On a case-sensitive file system, that also refuses a path that is not a case alias of a tracked path. One tracked name is enough: with `Specs/a.md` tracked, an ignored, untracked `specs` directory is refused. The operator renames the path or the tracked name.
- The operator path is the operator's own input and is stored in the state file. It is never file content.
- A link inside a listed directory is still skipped by name, as in ADR 0018. Only a link on the path itself is refused.
- The checks read the work tree at init. A swap between a check and the copy is the approved limit of ADR 0018.

## Alternatives

1. **Skip an unsafe path by name, as the fixed list does**: rejected. The operator typed the path, so a silent skip hides a mistake and leaves the child without the data.
2. **A configuration file of paths**: rejected. One flag per run needs no file, and the run state records it.
3. **Add the flag to the headless command**: deferred. The issue names the role init. The headless command can adopt the same checks later.
4. **Compare tracked names by canonical path only**: rejected. It reads every tracked file under the path, and the folded name compare closes the same bypass in one pass over the index.

## Authors

Andro Marces

## Links

- [Issue #980](https://github.com/andromarces/agent-loops/issues/980)
- [Pull request #983](https://github.com/andromarces/agent-loops/pull/983)
- Implementation: `normalizeLocalPath`, `refuseUnsafeLocalPaths`, and `copyLocalFiles` in `src/lib/local-files.mjs`, the flag in `src/role-args.mjs`; documented in [Local files in a linked work tree](../docs/reference/harness-entry-points.md#local-files-in-a-linked-work-tree), `docs/reference/install.md`, and `docs/orchestrator-instructions.md`
- Supersedes part of [ADR 0018](0018-copy-local-files-into-a-linked-run-work-tree.md)
- [ADR Index](README.md)
