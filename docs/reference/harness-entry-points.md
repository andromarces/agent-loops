# Interactive parent session

## Interactive orchestrator: harness entry points

An interactive parent session runs the same role rules through the subcommand,
driven by `docs/orchestrator-instructions.md`. One harness-neutral instruction
file defines the role; each supported harness gets a thin entry point that
names it rather than copying it. The file is a short core that names the
reference sections under `docs/orchestrator/`, and the parent reads a section
when the core says its condition holds. Role activation never goes into `AGENTS.md`
or `CLAUDE.md`, because dispatched children read those files; activation
happens only through explicit invocation.

| Harness         | Installed entry point                                  | Invocation                                    |
| --------------- | ------------------------------------------------------ | --------------------------------------------- |
| Claude Code     | `~/.claude/skills/agent-loop/SKILL.md`                 | `/agent-loop <task and role settings>`        |
| OpenCode        | `~/.config/opencode/plugins/parent-guard.ts`           | `/agent-loop <task and role settings>`        |
| Codex CLI       | `~/.agents/skills/agent-loop/SKILL.md`                 | `$agent-loop <task and role settings>`        |
| Copilot CLI     | `agent-loop-copilot` (packaged bin)                    | `agent-loop-copilot <task and role settings>` |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/agent-loop/SKILL.md` | `/agent-loop <task and role settings>`        |

`agent-loop install` writes these files from the templates under
`src/install/templates/`, and each rendered entry point points at the installed
`docs/orchestrator-instructions.md` by absolute path, so it works outside a
clone. Each skill renders the CLI by absolute path and runs every `agent-loop`
command in the instructions with that resolved invocation, so a Git Bash session
that cannot resolve the `agent-loop` command still starts a guarded run (#151).
`harness-check` exits 0 for a match, 3 when another harness is the nearest
ancestor, and 1 when the check cannot run or finds no harness ancestor, so the
skill separates a refusal from a check that did not decide. The Claude Code
skill names the instructions file by path with no `@` line, because an `@` line
in a skill body did not attach the file in a live session (#1055). It tells the
parent to read the file in full, and to read each reference section that the file names
when its condition holds. The core is expected to fit in one read of the read
tool. When the read tool caps a read, the skill tells the parent to read again
with an offset until the end of the file. See
[Parent guard details](../parent-guard.md) for every guard target.

Live check (issue #710, PR #1059): on 2026-10-25, Claude Code 2.1.310 on Windows 11 ran
`/agent-loop` from the installed user-scope skill. The parent read
`docs/orchestrator-instructions.md` (719 lines) in one read of the read tool, with no cap, and
reached the last line before the init call. A capped read with an offset did not occur, so that
path was not exercised.

Live check (issue #144): on 2026-10-10, two checks ran on macOS 27.2 with Node v26.11.1.
The tools were codex-cli 0.163.0-alpha.5 and GitHub Copilot CLI 1.0.96-2.
A `codex exec` session in full access ran each check, in a throwaway Git repository outside this work tree.
`CODEX_THREAD_ID` was set in both checks, and `COPILOT_CLI` in the second.

- `harness-check copilot` from the Codex shell exited 3 with `nearest harness ancestor is codex, not copilot`.
- `harness-check codex` from the shell of a Copilot session that the Codex shell started exited 3 with `nearest harness ancestor is copilot, not codex`.
  The Copilot session ran as `copilot -p` with model `gpt-5-mini`.

- The `~/.agents/skills` directory is shared. Copilot CLI and OpenCode also
  discover personal skills there, so the installed Codex skill appears in both.
  The Codex selection owns that directory; install and uninstall for Copilot
  never touch it. The Codex skill sets `metadata.opencode/autoinvoke: false`, so
  OpenCode drops it from the model's skill list and the model cannot auto-invoke
  it for an `/agent-loop` request; the OpenCode plugin command then owns
  `/agent-loop`. The skill also refuses to start a run when the nearest harness
  process is not Codex, so a Copilot or OpenCode session that inherits
  `CODEX_THREAD_ID` cannot start a run through it.
- The Claude Code skill sets `disable-model-invocation: true`, so only the
  maintainer activates it with `/agent-loop`, and it omits `context: fork`, so
  the skill runs in the current session. OpenCode also discovers
  `~/.claude/skills`, so a foreign OpenCode session lists this same copy to the
  model. The skill sets `metadata.opencode/autoinvoke: false`, so OpenCode drops
  it from the model's skill list and the model cannot auto-invoke it for an
  `/agent-loop` request; the OpenCode plugin command then owns `/agent-loop`.
  Before the init dispatch call the skill runs the installed CLI by absolute path
  with `harness-check claude`; exit 3 stops the run because another harness owns
  the session, and any other non-zero exit stops the run because the check could
  not run or found no harness ancestor. Both cover the literal
  `${CLAUDE_SESSION_ID}` that OpenCode leaves unexpanded. The resolved invocation
  then replaces `agent-loop` for the init dispatch and every later command, so the
  run does not need the `agent-loop` command on PATH. Its body passes
  `${CLAUDE_SESSION_ID}` as `--parent-session` on the init dispatch call.
- The OpenCode entry point is a user plugin at
  `~/.config/opencode/plugins/parent-guard.ts`, loaded automatically from that
  directory. Stored command templates expose no session id, so the plugin
  registers the `/agent-loop` command itself: its executor reads
  `CommandInvocation.sessionID` and carries that id into the orchestrator
  prompt, and the init dispatch call passes it as `--parent-session`. The shared
  Claude and Codex skills set `metadata.opencode/autoinvoke: false`, so OpenCode
  drops them from the model's skill list and the plugin command is the only
  `/agent-loop` entry point.
- The Codex CLI skill (`~/.agents/skills/agent-loop/SKILL.md`) activates only
  through `$agent-loop`. Before the init call it runs the installed CLI by
  absolute path with `harness-check codex`, which uses the same exit codes. Exit
  3 means another harness is the nearest ancestor; any other non-zero exit means
  the check could not run or found no harness ancestor. Either stops the run: an
  environment check cannot
  decide it, because a nested harness inherits `CODEX_THREAD_ID`. The resolved
  invocation replaces `agent-loop` for every command in the instructions. The
  skill passes `CODEX_THREAD_ID` as `--parent-session`. Use `$env:CODEX_THREAD_ID` in
  PowerShell and `$CODEX_THREAD_ID` in POSIX shells. In PowerShell, pass
  `--cwd $worktree` after setting `$worktree = (Get-Location).Path`. The CLI
  requires `--parent-session` and rejects an empty or unexpanded value before it
  initializes a run. This
  environment variable is an undocumented dependency and can change on upgrade.
  When it is absent, do not start a guarded run. Run `/hooks` once to review and
  trust the installed user hook; a changed hook command needs a new trust step.
  Do not use `--dangerously-bypass-hook-trust` for normal use.
- The Copilot CLI entry point is the packaged `src/entrypoints/copilot.mjs`,
  exposed as `agent-loop-copilot`. It mints a UUID, starts
  `copilot --session-id <uuid> --add-dir <docs dir> --interactive <prompt>`, and
  includes the instruction file, task, and same id for `--parent-session` in the
  first prompt. The current CLI documentation exposes no custom command-template
  session-id placeholder, so the launcher is the native entry point.
- The Antigravity CLI entry point is a skill at
  `~/.gemini/antigravity-cli/skills/agent-loop/SKILL.md`, activated as
  `/agent-loop` in an interactive session. It runs the installed CLI by absolute
  path with `harness-check antigravity` before the init call, and it replaces
  `agent-loop` with that resolved invocation for every command in the
  instructions. Then it passes
  `ANTIGRAVITY_CONVERSATION_ID` as `--parent-session`; use
  `$env:ANTIGRAVITY_CONVERSATION_ID` in PowerShell. This environment variable is
  an undocumented dependency and can change on upgrade, and child processes
  inherit it. When it is absent, or when the harness check stops the run, do not
  start a run.
- Universal fallback: reference `docs/orchestrator-instructions.md` in the first
  prompt and follow it when the harness entry point is not installed. The
  fallback must still pass the harness session id as `--parent-session`; the CLI
  refuses an init without it. The headless `agent-loop` command is the explicit
  unguarded path.
- On Copilot CLI, the installed `~/.copilot/hooks/parent-guard.json` registers
  PascalCase `PreToolUse`, so the payload carries `session_id` and `tool_name`,
  and the hook prints the flat `permissionDecision` object that Copilot CLI
  consumes. A live probe on Windows with Copilot CLI 1.0.87-0 confirmed the
  repository form of this hook loaded and reported `tool_name: Write`; no macOS
  runtime was available for that change. Copilot reads the shared subset of a
  _repository_ `.claude/settings.json`, which does not cover a Claude user
  guard, so Copilot gets its own user hook file; install never relies on Copilot
  reading the Claude user settings.
- The parent-edit guard (#57) reads `--parent-session` from the run's session
  entry (see [Parent guard details](../parent-guard.md)). Every `role` init
  requires `--parent-session`; a legacy state written without one keeps its
  parent unguarded.

## Parent guard: hard read-only for the parent session

The parent rule ("the orchestrator never edits files") is prompt-only, so a drifting parent session can still edit. Five harnesses add a hard guard for the file-edit tools, and all share the decision logic in `src/hook/decision.mjs`. See [Parent guard details](../parent-guard.md) for the per-harness matchers, the session-field mapping, and the pre-tool hook availability survey.

## Local files in a linked work tree

`git worktree add` checks out tracked files only, so a run work tree lacks the untracked, ignored files that configure a child agent. When `--cwd` is a linked work tree, the runtime copies them from the main work tree once, at init, before the first child spawns and before the first snapshot. The copy is on by default. `--no-copy-local-files` on the headless `agent-loop` command, or as an init field of `agent-loop role`, turns it off ([ADR 0018](https://github.com/andromarces/agent-loops/blob/main/adr/0018-copy-local-files-into-a-linked-run-work-tree.md)).

A file is copied only when it exists in the main work tree, is untracked there, and is ignored in `--cwd` by any ignore source (`.gitignore` of the branch in `--cwd`, `.git/info/exclude`, `core.excludesFile`). An untracked file that is not ignored in `--cwd` is skipped and reported.

Covered paths: `.agents/`, `.claude/`, `.codex/`, `.env`, `.envrc`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `opencode.jsonc`, `opencode.json`, `.github/copilot-instructions.md`, and `.vscode/`. For a directory, each file inside it meets the conditions on its own.

An operator adds paths to this list for one run with `--copy-local-path <relative path>`, an init field of `agent-loop role` that repeats once for each path ([ADR 0050](https://github.com/andromarces/agent-loops/blob/main/adr/0050-let-an-operator-add-ignored-paths-to-the-local-file-copy.md), issue #980). The path is relative to the main work tree. The init is refused, before any file is copied, any state file is written, or any child spawns, for: an empty path, an absolute or drive-qualified path, a `.` or `..` segment, `.git`, a segment with a colon or a trailing dot or space, a path that holds a file tracked in the main work tree (names compare ignoring case, so `SRC/foo` is refused when `src/foo` is tracked), a path with a symlink or a junction at any level, a path that does not resolve to the main work tree plus the path as written, a path that holds a file that is not ignored in `--cwd`, and use with `--no-copy-local-files`. The checks also run when `--cwd` is the main work tree, where nothing is copied. Every other rule in this section applies to the files under the path, and its files are named in `localFiles.copied` or `localFiles.skipped`. The run state stores the normalized paths as `copyLocalPaths`, and a later call must repeat the same set or omit the flag. Names in `localFilesCopied` cover the files for `localFilesDiffer`. The headless `agent-loop` command has no such flag.

- Nothing is overwritten, and the checks refuse to create or follow a symlink (within the swap limit stated below). A symlink in the main work tree, whatever its target, and a listed path under a symlinked directory are skipped and named. Nothing under `.git`, `.claude/worktrees/`, or any other work tree is copied, and neither is a `.gitignore` or `.gitattributes`, because a copy would change ignore rules or line endings in `--cwd`. A `*.lock` file under `.claude/`, such as `scheduled_tasks.lock`, is skipped and named too: it records a lock holder of the main work tree, and a copy would claim a lock that no process in `--cwd` holds (issue #964). Name exclusions ignore case, a trailing dot or space, and a stream suffix, so `.GITIGNORE` is skipped like `.gitignore`.
- Nothing is read from or written into `.git`, a registered work tree, or a directory that holds a `.git` entry, in either work tree.
- The copy uses `copyFile` with `COPYFILE_EXCL`, so an existing file is never replaced or deleted. Each file is checked first, and a file that fails a check is skipped and named: the source is opened without following a link and must be the regular file that the walk saw, with the same canonical path from `fs.promises.realpath` and the same device and inode (paths are compared as canonical strings, never folded, so `/repo` and `/REPO` stay two directories on a case-sensitive file system); only the excluded names `.git`, `.claude/worktrees`, `.gitignore`, `.gitattributes`, and `.claude/**/*.lock` are matched case-insensitively, which can only skip more, and the target directories must be real directories outside any registered work tree and with no `.git` entry. Approved limit (repository owner, 2026-10-04, [ADR 0018](https://github.com/andromarces/agent-loops/blob/main/adr/0018-copy-local-files-into-a-linked-run-work-tree.md)): Node has no descriptor-relative open, so a parent directory or a link swapped between a check and the copy can redirect that read or write. A swap needs local write access to the work trees during init. The copy was not run against a native Windows file system or a mount point.
- A file over 1 MiB is skipped. A listed directory that holds more than 2000 entries, counted under it with nested directories, is skipped as one name, and none of its files is copied. Each listed path has its own bound.
- A copy leaves `clean` and the snapshot digest unchanged, because a copied file is ignored.
- `--cwd` as the main work tree copies nothing. The main work tree is the first entry of `git worktree list --porcelain -z`, taken only when it is not marked `bare`, is an existing directory, and is neither the common Git directory (`git rev-parse --git-common-dir`) nor inside it. Every other layout, a bare repository (also one named `.git`), a plain separate Git directory, a submodule, and a first entry inside the Git directory, copies nothing: the run logs that no main work tree was found and the init does not fail (maintainer decision, 2026-10-05, [ADR 0018](https://github.com/andromarces/agent-loops/blob/main/adr/0018-copy-local-files-into-a-linked-run-work-tree.md)). A Git command that fails while the main work tree is looked up fails the init with an error. Paths from Git are read NUL-safe (`-z` for the worktree list, `git ls-files -z`, `git check-ignore -z`), so a newline in a path cannot cut it short; a Git that rejects `-z` for `git worktree list` fails the init instead of falling back. Single values are read byte-exact (execa runs with `stripFinalNewline: false`, and only the one line feed that Git adds is removed). When `--cwd`, the work tree, a registered work tree, the main work tree, or the common Git directory has a control character in its path (a line feed, a carriage return, a tab, and so on), nothing is copied, the init does not fail, and the run logs it. This is an approved exception to Acceptance 1 of issue #423 (repository owner, 2026-10-05, [ADR 0018](https://github.com/andromarces/agent-loops/blob/main/adr/0018-copy-local-files-into-a-linked-run-work-tree.md)): a run in such a work tree gets none of the local files.
- A later `role` dispatch compares each copied file with its source in the main work tree by SHA-256 and names the differing files in the envelope as `localFilesDiffer`, absent when none differs. It writes nothing, so a copy that a turn changed is never overwritten, and it cannot tell a turn edit from a change in the main work tree. A file over 1 MiB (also when both sides are over), a symlink on the file or on any directory above it in either work tree (never read through), a file whose identity or path changes while it is read, and a file missing from one side count as differing; a file missing from both is not reported. Each file is resolved first and must resolve to its work tree root plus its relative name, with no link on any ancestor, before it is opened. The read uses the open handle after device, inode, and canonical-path checks, and the ancestors are checked again after the read. A file that is absent at the first probe is missing; one that vanishes after it is not comparable. A link that is inserted and left in place is rejected before the read. Known limit: a swap that is made and undone between two checks is not detected, and it needs local write access to the work trees. The init stores the copied names in the run state as `localFilesCopied`. The headless run and a run that passed `--no-copy-local-files` do not compare (issue #933).
- The report names paths only, in the `role` init envelope as `localFiles: {"copied": [...], "skipped": [...]}`, with no such key when the copy did not run, and in the `local-files` transcript event. A later call that passes `--no-copy-local-files` against a run that copied is refused, like every other init field. The runtime never prints, logs, or transcribes file content.
- Secrets: `.env`, `.envrc`, `.mcp.json`, and files under `.claude/`, `.codex/`, or `.vscode/` can hold secrets. The copy is a second copy on disk inside the run work tree. Pass `--no-copy-local-files` to avoid it. The worker preamble and the reviewer prompt tell the child never to read, print, or quote `.env` or another ignored secret file, to check a configuration value by name and presence only, and to keep a content search to tracked files (issue #1248). The rule is advisory, and the runtime does not detect a breach: it redacts secret-named environment variable values only in the `--test-cmd` output tail, and never in what a child prints in its own turn.
- A work tree that a child creates for itself during a turn is not covered.
