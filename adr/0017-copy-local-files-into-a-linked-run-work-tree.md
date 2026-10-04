# 0017. Copy untracked local files into a linked run work tree

## Status

accepted

## Date

2026-10-04

## Context

`git worktree add` checks out tracked files only. A run work tree that the parent
creates therefore lacks the untracked and ignored files that configure a child:
`AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.claude/`, `.codex/`, `.env`, and similar
paths. The child agents then run without their instructions, harness configuration,
or environment (issue #423). Claude Code has `.worktreeinclude`, but it covers only
work trees that Claude Code creates.

Until now the runtime only validated `--cwd` and never wrote into it. Copying
files is a new runtime contract, and it handles files that can hold secrets.

## Decision

1. **Scope.** At init, when `--cwd` is a linked work tree, the runtime copies a file
   from the main work tree into `--cwd`. The main work tree is the first entry of
   `git worktree list`. The copy happens once, before the first child spawn and the
   first snapshot. It is on by default.
2. **Three conditions.** A file is copied only when all three hold:
   1. It exists in the main work tree.
   2. It is untracked in the main work tree (`git ls-files` there).
   3. `git check-ignore` run in `--cwd` names it ignored. Every ignore source
      counts: the `.gitignore` files of the branch checked out in `--cwd`, the
      shared `.git/info/exclude`, and `core.excludesFile`. The check runs in
      `--cwd`, not in the main work tree, because a `.gitignore` comes from the
      branch and can differ between the two.
3. **Listed paths.** `.agents/`, `.claude/`, `.codex/`, `.env`, `.envrc`,
   `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `opencode.jsonc`,
   `opencode.json`, `.github/copilot-instructions.md`, and `.vscode/`. For a
   directory, each file inside it meets the three conditions on its own, so a
   partly tracked directory copies only its untracked, ignored files. The
   `--cwd` root is the toplevel of its work tree, so a `--cwd` in a subdirectory
   still receives the files at the root.
4. **Skipped, not copied.** An untracked file that is not ignored in `--cwd` is not
   copied and is reported as skipped. A file that already exists in `--cwd`, a
   file whose target path sits under a symlink, a file over the size cap, and a
   file whose copy failed are reported as skipped. A path that is tracked in the
   main work tree or absent from it is not a local file and is not reported.
5. **No overwrite.** The copy uses `COPYFILE_EXCL`, so a file of `--cwd` is never
   replaced. A tracked file of `--cwd` is never replaced, because it either exists
   (refused as above) or is not ignored (condition 3).
6. **Symlinks.** The copy never follows a symlink and never creates one. A listed
   path that is a symlink, an entry inside a listed directory that is a symlink,
   and a listed path under a symlinked ancestor in the main work tree are skipped
   by name. A target under a symlinked ancestor in `--cwd` is skipped, so a write
   cannot leave `--cwd`. A copy, not a link, because a Windows symlink needs extra
   privileges and a copy does not follow later edits in the main work tree.
7. **Work trees are excluded.** `.claude/worktrees/`, every directory that
   `git worktree list` names, and every directory that holds a `.git` entry are
   never walked and never reported.
8. **Size cap.** A file over 1 MiB is skipped and named. A listed directory whose
   walk passes 2000 entries is skipped as one name, with none of its files copied.
   The cap applies to `.agents/`, `.claude/`, `.codex/`, and `.vscode/`, where
   caches, logs, and session stores can sit beside small configuration files.
   There is no cap flag.
9. **Nothing without a main work tree.** When `--cwd` is the main work tree, or the
   repository is bare, nothing is copied and nothing is reported.
10. **Opt-out.** `--no-copy-local-files` is an init field of `agent-loop role` and
    a flag of the headless `agent-loop` command. With it, nothing is copied and
    the behavior is as before. The role init stores `copyLocalFiles` (a boolean) in
    the state file. A later call that passes the flag against a run that copied is
    refused, as for every other init field. A state file written before the field
    holds no value and copied nothing.
11. **Secrets.** The runtime never prints, logs, returns, or transcribes file
    content. It reads bytes only through `copyFile`. Every report holds root-relative
    path names. A copy failure logs the error code only. The state file holds the
    boolean, not the names.
12. **Reporting.** The interactive init envelope carries
    `localFiles: { copied, skipped }`. Both paths emit one `local-files` event with
    the same two lists, which the transcript records. A run with the opt-out, a main
    work tree, or a bare repository has no envelope key and no event. The log holds
    counts only.
13. **Snapshot.** A copied file is ignored, so `git status` never lists it, and
    `clean` and the snapshot digest do not change.
14. **Failure.** A copy step that cannot run (for example `git` fails) fails the
    init before the state file exists, so no run is left to abort. A single file
    that fails to copy is skipped and named.

## Consequences

- A child in a linked run work tree gets the same local instructions and
  environment as the main work tree, whatever harness created the work tree.
- A secret such as `.env` is duplicated on disk inside the run work tree. The
  duplicate is ignored by Git, so it is never staged by `git add -A` or reported
  by the snapshot, but the work tree now holds a second copy that the owner must
  remove with the work tree. A parent that wants no copy passes the opt-out.
- A copy does not follow later edits in the main work tree.
- A work tree that a child creates for itself during a turn is not covered.
- The runtime has a bounded set of paths. A new harness file needs a code change.
- A concurrent writer in the main work tree can swap a source file for a symlink
  between the `lstat` check and the copy. The main work tree belongs to the caller,
  so that actor is outside the threat model.
- Windows: no symlink is created, so the contract needs no extra privilege. File
  mode bits are those that `copyFile` preserves on the platform.

## Alternatives

1. **Symlink the files**: rejected. A Windows symlink needs extra privileges, and a
   link follows later edits and could expose the main work tree to a child write.
2. **A configurable path list or a size flag**: rejected. A config value that has
   one reasonable setting is speculative. The list and the cap change with a code
   change.
3. **Copy by evaluating ignore rules in the main work tree**: rejected. A
   `.gitignore` comes from the branch of each work tree, so the main work tree can
   ignore a path that `--cwd` does not, and the copy would then show up as an
   untracked change that breaks the mutation check.
4. **Create the run work tree in the runtime**: rejected. The parent owns the work
   tree (`docs/orchestrator-instructions.md`, "Work tree ownership").
5. **Copy on every dispatch**: rejected. Init-only keeps the contract simple and
   keeps a later edit of a copied file in `--cwd` from being overwritten or
   reported as a change.

## Authors

Andro Marces

## Links

- [Issue #423](https://github.com/andromarces/agent-loops/issues/423)
- Implementation: `copyLocalFiles` in `src/lib/local-files.mjs`, the init copy in
  `src/role.mjs` and `runLoop` in `src/runtime.mjs`, and the flags in `src/cli.mjs`;
  documented in `README.md` and `docs/orchestrator-instructions.md`
- [ADR Index](README.md)
