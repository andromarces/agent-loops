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
   `git worktree list --porcelain -z` under the rule of decision 10. The copy happens once, before the first child spawn and the
   first snapshot. It is on by default.
2. **Three conditions.** A file is copied only when all three hold:
   1. It exists in the main work tree.
   2. It is untracked in the main work tree (`git ls-files` there). A file that
      Git tracks is tracked under any spelling that reaches it, so the tracked
      names under the listed paths are also compared by canonical path: on a
      case-insensitive file system `.claude/config` is the tracked
      `.Claude/config` and is not copied.
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
   file whose target path sits under a symlinked directory, a registered work
   tree, or a directory that holds a `.git` entry in `--cwd`, a file over the size
   cap, a `.gitignore` or `.gitattributes`, and a file whose copy failed are
   reported as skipped. A path that is tracked in the main work tree or absent
   from it is not a local file and is not reported.
5. **No overwrite.** The copy uses `fs.copyFile` with `COPYFILE_EXCL`. The exclusive
   create refuses an existing file and never deletes it, and the code removes
   nothing. A tracked file of `--cwd` is never replaced, because it either exists
   (refused as above) or is not ignored (condition 3).
6. **Symlinks.** The policy is the narrowest that the issue text states, and the
   simplest to check. Issue #423 says "The copy must not follow a symlink out of
   the main work tree" and "Copy, do not symlink". Following a link that stays
   inside the tree would need a check of the link target, so no symlink is followed
   at all. A symlink entry, whatever its target, is skipped by name, and so is a
   listed path under a symlinked directory of the main work tree. The copy never
   creates a symlink. In `--cwd`, a target under a symlinked directory is skipped,
   because the write would leave `--cwd`, and `git check-ignore` refuses such a
   path. These checks run before the copy and are subject to the swap limit of
   decision 9. A copy, not a link, because a Windows symlink needs extra
   privileges and a copy does not follow later edits in the main work tree.
7. **Work trees and Git files are excluded.** Isolation holds on both sides. In the
   main work tree, `.claude/worktrees/`, every registered work tree that `git
worktree list` names (even when its `.git` entry is gone), every directory that
   holds a `.git` entry (a file or a directory), and any path component named
   `.git` are never walked and never reported. In `--cwd`, a target is never
   written inside a registered work tree other than `--cwd` itself, nor inside a
   directory that holds a `.git` entry, and such a file is reported as skipped. A
   `.gitignore` or `.gitattributes` is never copied, because a copied one changes
   ignore rules or line endings in `--cwd`: it can un-ignore a file that was
   copied, so that the snapshot lists it and the run's `clean` flag and digest
   change. Only the excluded names (`.git`, `.claude/worktrees`, `.gitignore`,
   `.gitattributes`) are compared by folding: lower case, without a stream suffix
   (`name:stream`), and without trailing dots or spaces. A folded match includes
   the exact match, so folding can only skip more files, never read or write more.
   A case or Windows alias such as `.GITIGNORE`, `.GitAttributes`, `.gitignore.`,
   or `.Claude/Worktrees` therefore matches its plain name. A path is never
   folded: paths are compared as the canonical strings that `fs.promises.realpath`
   returns.
8. **Size cap.** A file over 1 MiB is skipped and named. Each listed directory has
   its own bound of 2000 entries, counting every entry read under it, nested
   directories included. A listed directory that holds more than 2000 entries is
   skipped as one name (the listed path, for example `.codex`), with none of its
   files copied. A directory over the bound does not use up the bound of another
   listed path.
   The cap applies to `.agents/`, `.claude/`, `.codex/`, and `.vscode/`, where
   caches, logs, and session stores can sit beside small configuration files.
   There is no cap flag.
9. **Checks, and the approved swap limit.** Each file passes these checks, in
   order, and a file that fails one is skipped and reported:
   1. The walk records the canonical path of each candidate file, from
      `fs.promises.realpath`, after it checked with `lstat` that no path component
      is a symlink. Just before the copy, the source is opened once with
      no-follow, and the opened file must be the regular file within the size cap
      that the walk saw: `fs.promises.realpath` of the path must still equal the
      recorded canonical path, and the `fstat` identity (device and inode) of the
      opened file must equal the `lstat` identity of the path. The Node
      documentation states that `fsPromises.realpath` determines the location with
      the same semantics as `fs.realpath.native()`. The callback `fs.realpath` is
      a different, JavaScript implementation and is not used: a probe on
      2026-10-04 with Node 26.8.1 on macOS showed it returns the spelling that was
      passed in, while `fs.promises.realpath` and `fs.realpath.native` returned the
      on-disk spelling on a case-insensitive APFS volume, and the exact spelling on
      a case-sensitive volume. On a case-insensitive file system the canonical
      string is the on-disk spelling, on a case-sensitive one the exact spelling.
      Two strings are therefore equal exactly when no symlink and no other
      directory lies on the path, and `/repo` and `/REPO` are two directories where
      the file system keeps them apart. No guess about the file system is made, so
      no probe of it exists.
   2. Missing target directories are created one level at a time, and every
      ancestor in `--cwd` must be a real directory, with no `.git` entry, outside
      every registered work tree.
   3. `copyFile` with `COPYFILE_EXCL` copies the file.
      Limit, approved by the repository owner on 2026-10-04: Node has no
      descriptor-relative open, and `copyFile` reads and writes by path. A parent
      directory or a link swapped between a check and the `copyFile` call can
      therefore redirect that read or write. A swap needs local write access to the
      main work tree or to `--cwd` while the init runs. The checks narrow the window
      and detect a swap that is in place when they run. They do not prevent a swap
      inside the window, and a file that such a swap redirects is still reported as
      copied. The runtime claims no more protection than that.
10. **Finding the main work tree.** Decided by the repository owner on 2026-10-05.
    The main work tree is the first entry of `git worktree list --porcelain -z`,
    and only when all three hold: the entry is not marked `bare`, its path is an
    existing directory, and its canonical path (`fs.promises.realpath`) is neither
    the common Git directory (`git rev-parse --git-common-dir`, canonical) nor
    inside it. Every other layout has no main work tree for this copy: a bare
    repository (including one named `.git`), a plain separate Git directory made
    by `git init --separate-git-dir`, a submodule, and a first entry inside the
    Git directory. In each of them nothing is copied, the init does not fail, and
    the run logs `no main work tree found, so nothing is copied`. This is an
    approved rule, not a limit that Git forces: a lookup through the Git
    configuration or the name of the Git directory was removed to keep one rule
    that follows the first entry. A Git command that fails while the list or the
    common Git directory is read fails the init (decision 15). Evidence, probed on
    2026-10-05 with Git 2.56.0 and checked against the Git documentation for
    `git worktree list --porcelain`: each record starts with a `worktree <path>`
    field, a `bare` field appears only for a bare repository, and an empty field
    ends the record. For a normal clone the first entry is the checkout. For a bare
    repository it is the repository, marked `bare`. For a repository with a
    separate Git directory it is the Git directory. When `--cwd` is the main work
    tree, nothing is copied and nothing is reported.

    Paths are read NUL-safe. A path can hold a newline, and the plain porcelain
    output would cut it there, which could select another directory (a main path
    `/repo` followed by a newline and `main` read as `/repo`) or leave a registered
    work tree unexcluded. The list is therefore read with `-z`. The Git
    documentation describes `-z` as making the output parseable when a worktree
    path contains a newline, and a probe with Git 2.56.0 showed a path with a
    newline arriving whole, with each field ended by NUL. The same rule holds for
    every other Git output that the copy parses for paths: `git ls-files -z` and
    `git check-ignore -z` already use it. The single-value outputs `git rev-parse
--show-toplevel` and `--git-common-dir` have no `-z`, so exactly one
    end-of-line is removed from them and nothing else, because a path can start or
    end with a space. The repository does not state a minimum Git version, and the
    first Git release that accepts `-z` for `git worktree list` was not verified
    here. A Git that rejects the option makes the command fail, and the init fails
    with Git's error (decision 15). It never falls back to the plain format.

11. **Opt-out.** `--no-copy-local-files` is an init field of `agent-loop role` and
    a flag of the headless `agent-loop` command. With it, nothing is copied and
    the behavior is as before. The role init stores `copyLocalFiles` (a boolean) in
    the state file. A later call that passes the flag against a run that copied is
    refused, as for every other init field. A state file written before the field
    holds no value and copied nothing.
12. **Secrets.** The runtime never prints, logs, returns, or transcribes file
    content. Bytes move only through `copyFile`. Every report holds root-relative
    path names. A copy failure logs the error code only. The state file holds the
    boolean, not the names.
13. **Reporting.** The interactive init envelope carries
    `localFiles: { copied, skipped }`. Both paths emit one `local-files` event with
    the same two lists, which the transcript records. A run with the opt-out, a main
    work tree, or a bare repository has no envelope key and no event. The log holds
    counts only.
14. **Snapshot.** A copied file is ignored, so `git status` never lists it, and
    `clean` and the snapshot digest do not change.
15. **Failure.** A copy step that cannot run (for example a `git` command fails,
    including while the main work tree is looked up or probed) fails the init with
    an error that names the command, before the state file exists, so no run is
    left to abort. A failed probe never reads as "no main work tree". A single file
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
- A symlink in the main work tree is never copied, even when it points inside the
  tree. A parent that shares one instruction file by symlink must copy it itself.
- A mount point inside the main work tree is not a symlink and is walked like a
  directory. A file system that the caller mounted there is the caller's choice.
- Windows: no symlink is created, so the contract needs no extra privilege. The
  no-follow open flag does not exist there, so the canonical path and identity
  checks of decision 9 carry the guard alone. The name folding of decision 7 and
  those checks were not run against a native Windows file system or a mount point
  during this change; CI covers the portable behavior only. The target
  keeps the permission bits of the source, reduced by the process umask.

## Alternatives

1. **Follow a symlink that resolves inside the main work tree**: rejected in the
   second revision. The issue requires only that no link is followed out of the
   tree, and following one inside needs a target check that a swap can defeat, and
   exclusion checks for `.git`, other work trees, loops, and tracked files reached
   by two paths. No symlink is followed, which has none of those cases.
2. **Symlink the files into `--cwd`**: rejected. A Windows symlink needs extra privileges, and a
   link follows later edits and could expose the main work tree to a child write.
3. **A configurable path list or a size flag**: rejected. A config value that has
   one reasonable setting is speculative. The list and the cap change with a code
   change.
4. **Copy by evaluating ignore rules in the main work tree**: rejected. A
   `.gitignore` comes from the branch of each work tree, so the main work tree can
   ignore a path that `--cwd` does not, and the copy would then show up as an
   untracked change that breaks the mutation check.
5. **Create the run work tree in the runtime**: rejected. The parent owns the work
   tree (`docs/orchestrator-instructions.md`, "Work tree ownership").
6. **Copy on every dispatch**: rejected. Init-only keeps the contract simple and
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
