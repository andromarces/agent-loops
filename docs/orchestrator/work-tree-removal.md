# Removing a work tree

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when you remove the work tree of a terminal run, after the core rule on the terminal state is met.

Remove the work tree with `git worktree remove --force "<work tree>"`,
then check whether the folder still exists. On Windows, the remove can leave the
folder when a turn ran `pnpm install`: it holds `node_modules` with junctions into
the shared pnpm store and no file. When the folder remains, check that it holds
only links and directories. On Windows, run
`Get-ChildItem -LiteralPath "<work tree>" -Recurse -Force -Attributes "!Directory+!ReparsePoint"`
in PowerShell. On POSIX, run `find "<work tree>" -not -type d -not -type l`. Each
command includes hidden files and never descends into a link or a junction. Any
path that it prints is a file: stop and leave the folder to a maintainer. When it
prints nothing, delete the folder without following links:
`cmd.exe /c rmdir /s /q "$($wt.Replace('/', '\'))"` in PowerShell, with the work tree path in `$wt`,
`cmd.exe /c rmdir /s /q "<work tree>"` in cmd.exe,
`MSYS_NO_PATHCONV=1 cmd.exe /c rmdir /s /q "$(cygpath -w "<work tree>")"` in Git
Bash, `rm -rf "<work tree>"` on POSIX, which does not follow symbolic links. The
cmd.exe forms need a path with backslashes, because `cmd.exe` reads a forward slash
as a switch and fails with `Invalid switch`. Git prints work tree paths with forward
slashes on Windows, so the PowerShell form converts the path. A harness PowerShell
tool has refused the PowerShell form with `Remove-Item on system path '/s' is blocked`.
The cause is not confirmed. Claude Code 2.1.310 in the bypass-permissions mode ran the
form with no refusal on 2026-10-25, so the refusal can depend on the version or the
permission mode. When it refuses, run the Git Bash form instead. Run
the Windows delete as `cmd.exe /c rmdir`, because Git Bash resolves a bare `rmdir`
to GNU rmdir, which rejects those switches. In Git Bash, keep `MSYS_NO_PATHCONV=1`,
because MSYS path conversion rewrites the `/s` and `/q` switches, and `cmd.exe`
then exits 0 and leaves the folder. Never use a recursive delete that follows
junctions: it can damage the shared pnpm store.
