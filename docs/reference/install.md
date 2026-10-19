# Installation

## Requirements

- Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` (22.18.0 or later on the 22 line, 24.11.0 or later on the 24 line, or 26.0.0 or later)
- Git (the target `--cwd` must be inside a Git work tree)
- Installed and authenticated CLI agents

pnpm is required only for development in a clone, not for a registry install.

The package `engines.node` range
matches the `vite-plus` range. On a Node version outside it, npm warns, and with
`engine-strict` set the install fails.

## Install

Install the CLI globally:

```bash
npm install -g @andromarces/agent-loops
# or
pnpm add -g @andromarces/agent-loops
```

Set up the harness entry points and parent guards at user scope:

```bash
agent-loop install
```

`install` detects the harness CLIs on `PATH`, preselects them, and writes the
entry point and guard for each selected harness. It is interactive; pass
`--harness <list> --yes` for scripts, and `--dry-run` to print the planned
writes without changing anything. A second run with the same package makes no
change. `agent-loop uninstall` removes only the files and settings entries the
install recorded, and restores a file that install changed when the file is
otherwise unchanged. Install applies a harness guard before its entry point, and
if a write fails part way through it records the writes that completed, so
`uninstall` still removes or restores them. It leaves a target in place when it
cannot remove or restore it safely; see [Uninstall skips](#uninstall-skips). If
`~/.agent-loops` exists as a regular file, `install` and `uninstall` both stop
with an error and change nothing, on every platform. Move or remove the file,
then run the command again.

`--verbose` on `install` and `uninstall` turns on debug-level logging.

A real `install` or `uninstall` holds the lock file `~/.agent-loops.lock` (beside
`~/.agent-loops`, under `AGENT_LOOP_HOME` when set), so two commands on one home
contend whatever their `TMPDIR` or `TEMP` values are. The lock is released when the
command ends, so a full `uninstall` leaves the home empty. A crash leaves a stale
lock that the next command removes once its owner process is dead. A dry run takes
no lock and writes nothing. If lstat of the home reports ENOENT, `uninstall`
returns at once without a lock, reports nothing to remove, writes nothing, and
exits 0, so it never creates the home. This includes a Windows path that cannot
name a directory, which now reports nothing to remove instead of an error. See [ADR 0025](https://github.com/andromarces/agent-loops/blob/main/adr/0025-lock-the-install-manifest-beside-the-home.md).

`install` must run from an install whose package location survives an upgrade: a
global install, a project install, or a linked clone. It writes the package
location as an absolute path into every entry point and guard. The `npx`,
`pnpm dlx`, `yarn dlx`, and `bunx` runners place the package in a cache or
temporary directory. The runner or the system can delete that directory. When
`install` detects its own package root inside that directory, it refuses. The
message asks for a global install first, so `install` never writes a path that
can disappear.

The `bunx` layout was observed on macOS with bun 1.2.20 and on
Windows 11 with bun 1.3.8. The `yarn dlx` layout was observed on macOS with yarn
4.9.2. On Windows 11 with yarn 4.9.2, only the `%TEMP%\xfs-<hex>\dlx-<pid>`
part was observed. The `<package>.zip\node_modules\<package>` suffix was not
observed on Windows. Yarn 1.22.22 on macOS has no `dlx` command. On macOS, its
`create` command installed a probe package into the stable global directory.

Linux (#707) and a `%TEMP%` that is an 8.3 short path or a junction (#709) are
not verified. Inside a Codex turn, `install` also checks the temporary
directories that the turn inherited. `AGENT_LOOP_INHERITED_TMPDIR` lists them as
a JSON array of absolute paths, so the refusal holds there too. A value that is
present but is not such a list makes `install` refuse every root. `uninstall` reads only the
manifest and the harness files, so it still removes them after the package is
gone.

A pnpm install resolves the package into a version-named virtual store entry, so
the resolved path does not survive an upgrade. `install` writes the
version-independent path instead, and checks that the path it writes resolves to
the installed package before using it.

- A pnpm 12 global install puts the store entry in an install directory and keeps a
  hash-named symlink beside that directory, which the `agent-loop` bin shim calls, so
  `install` writes it.
- A pnpm 10 install puts its store directory beside the `node_modules` it links the
  package under, which `pnpm root -g` reports, so `install` writes that link.
- A pnpm 12 project install on Windows links the package from a global store whose path
  names no project. The project `node_modules/.pnpm` directory holds no store entry there.
  `install` writes the project link instead, which the bin shim calls.
- A pnpm 12 project install on macOS links the package into the project
  `node_modules/.pnpm` directory, which holds a version-named entry. `install` writes the
  project link there too, so the rendered path carries no version.

An upgrade repoints every one of them. An npm global install, a clone, and a linked
package have no version in their root and render unchanged, and so does any layout
with no link that resolves to the package. See [Upgrade](#upgrade) for the step
after an upgrade.

The pnpm 12 project layout was checked end to end on Windows 11 with pnpm 12.8.1 and
a temporary `AGENT_LOOP_HOME` and store (#340):

- `pnpm add <0.5.0 tarball>`, then `pnpm exec agent-loop install --harness claude --yes`,
  rendered `node "<project>\node_modules\@andromarces\agent-loops\src\hook\parent-guard.mjs"`.
  No store path appears in it.
- `pnpm add <0.5.1 tarball>` replaced the store entry, and `pnpm store prune` removed
  the old one. The rendered hook path still existed and ran with exit code 0, and a
  second `install` reported `noop` for every file.

The macOS check used Darwin 27.2.0, pnpm 12.10.1, Node v26.11.1, a temporary `HOME` and
`AGENT_LOOP_HOME`, and a scratch store. Every pnpm command that reads or writes a store
passed `--store-dir`. Only `pnpm --version` ran without it. A `pnpm store path` check
confirmed the scratch store before the prune (#340):

- `pnpm add @andromarces/agent-loops@0.5.0`, then `pnpm exec agent-loop install --harness claude --yes`,
  rendered `node "<project>/node_modules/@andromarces/agent-loops/src/hook/parent-guard.mjs"`.
  No store path appears in it. The hook file existed and the hook exited with code 0.
- Version 0.4.0, which predates the project link, rendered
  `node "<project>/node_modules/.pnpm/@andromarces+agent-loops@0.4.0/node_modules/@andromarces/agent-loops/src/hook/parent-guard.mjs"`.
- `pnpm add <0.5.1 tarball>` moved the project link to a new `node_modules/.pnpm` entry.
  `pnpm store prune` then reported `Removed 382 files (2183484 bytes)` and
  `Removed 21 packages`. The rendered hook path still existed and exited with code 0.
  A second `install` reported `noop` for both files.

Not verified:

- Linux: the check ran on macOS only.
- A project on a UNC share: `pnpm add` fails there before `install` can run.
  Over `\\localhost\C$`, pnpm 12.8.1 reports `Failed to symlink
  "@andromarces/agent-loops" for importer "."` with `Access is denied. (os error 5)`.
  The render on a UNC share stays covered by the fallback test only.

Install the entry points for two harnesses without a prompt, then remove them:

```bash
agent-loop install --harness claude,codex --yes
agent-loop uninstall
```

### Upgrade

Upgrade the package, then run `install` again with the same harness list:

```bash
npm install -g @andromarces/agent-loops@latest
# or
pnpm add -g @andromarces/agent-loops@latest
agent-loop install --harness <list> --yes
```

Run the second command after every upgrade. It makes no change when nothing
changed, so it is safe to run when unsure. It is required when:

- The upgrade starts from 0.3.0 or 0.4.0, the releases that have `install`, and the
  package sat in a pnpm install listed above (a pnpm 10 or pnpm 12 global or project install). Those versions
  wrote the resolved, version-named pnpm store path, which an upgrade deletes. The
  installed files keep naming that directory until `install` runs again, including
  for a pnpm 12 project install (#311). An npm global install, a clone, and a linked
  package wrote a path with no version, so this case does not apply to them.
- A release adds or changes harness files, for example a new hook or a changed entry
  point. Those files reach a harness only through a new `install`.

When a hook command changes, Codex asks for a new trust step. Run `/hooks` in Codex
to review and trust the changed hook.

### Uninstall skips

`agent-loop uninstall` prints one line per target as
`<harness>: <action> <path> (<detail>)`. A target that it cannot remove or
restore safely reports `skip`, stays on disk, and loses its manifest record:
uninstall deletes the harness record, and removes the manifest when no harness
remains. Uninstall never retries a skipped target, and a backup file can remain
on disk with no record. Recover a skipped target by hand.

`install` writes a backup at `<file>.agent-loops-backup` when the target existed
before install and install changed it, and uninstall reads that file to restore
the pre-install bytes. Install writes no backup when the target did not exist
before install, and none when it already held the installed bytes.

| Reported detail                                    | Target   | What stays on disk                                                   | Manual recovery                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owned file changed since install; left unchanged` | file     | The file, with your later edits, and a backup when present           | Restore `<file>.agent-loops-backup` over the file when that backup exists and you want the pre-install content, or delete the file when you do not want it. Delete the backup by hand when it stays behind.                                                           |
| `backup missing; left unchanged`                   | file     | The file, unchanged since install, with no backup                    | Install wrote no backup when the file already held the installed bytes, so the file can be your original and needs no change. Otherwise restore the original from version control or another copy, or delete the file when you do not want the installed entry point. |
| `settings do not parse; left unchanged`            | settings | The settings file, still invalid, and a backup when present          | The record is gone, so no later `agent-loop uninstall` retries it. Repair the syntax and remove the recorded entry by hand, or restore `<file>.agent-loops-backup` when that backup exists and your later edits can be discarded. Then delete the backup.             |
| `recorded entry not found; left unchanged`         | settings | The settings file, with no recorded entry, and a backup when present | The recorded entry is already gone. Remove another agent-loop entry by hand when one is present, then delete the backup when it exists.                                                                                                                               |
| `backup missing; left unchanged`                   | settings | The settings file, still holding the recorded entry                  | Remove the recorded entry by hand, or restore the original from version control or another copy. The backup is gone, so none remains to delete.                                                                                                                       |

When a settings file changed after install but still parses and holds the
recorded entry, uninstall reports `remove-entry` instead: it removes only that
entry, keeps your edits, and leaves the result not byte-identical. The backup at
`<file>.agent-loops-backup` stays behind, so delete it by hand when you no
longer need the pre-install copy.

### Run without installing

Run the CLI from the package cache:

```bash
npx @andromarces/agent-loops --help
pnpm dlx @andromarces/agent-loops --help
```

`--help` writes no config, so it runs from the cache. `install` writes config
that points at the package, so it refuses from the cache; see [Install](#install).

### Install from a Git URL

Install from a Git URL instead of the registry:

```bash
npm install -g github:andromarces/agent-loops
```

npm 12 disables git fetches by default. On npm 12, pass `--allow-git=all`:

```bash
npm install -g --allow-git=all github:andromarces/agent-loops
```

A Git URL install also installs the devDependencies, including `vite-plus`.
On npm 12, the install blocks the `prepare` script and prints a message like
`1 package had install scripts blocked`. That message is expected. The install still exits 0, and `agent-loop`
works without `prepare`. To run `prepare`, add
`--allow-scripts=@andromarces/agent-loops`:

```bash
npm install -g --allow-git=all --allow-scripts=@andromarces/agent-loops github:andromarces/agent-loops
```

### The `agent-loop` command

The `bin` script keeps its `#!/usr/bin/env node` shebang and executable bit, so macOS and Linux link an executable file. npm generates the `.cmd` and `.ps1` shims on Windows, so `agent-loop` resolves in PowerShell and cmd. An `agent-loops` alias points at the same CLI, so `npx @andromarces/agent-loops` and `pnpm dlx @andromarces/agent-loops` resolve it. The command locates its package files relative to the installed script, not `process.cwd()`, so it works from any directory; `--cwd` selects the work tree.

### From a clone (development)

Development uses pnpm and the repository Git hooks. The dev toolchain is
Vite+ (`vite-plus`), which needs the Node range in [Requirements](#requirements).
The `pre-commit` hook runs `vp staged`, which needs Node 22.22.1 or later on the
22 line, or 24.11.0 or later, and Git 2.32.0 or later. Every script runs the
project-local `vp`, so no global `vp` install is needed. User-scope integrations
point at the package location, so a clone registers its own copy with `npm link`
before `agent-loop install`:

```bash
git clone <repository-url>
cd agent-loops
pnpm install
npm link
agent-loop install
```

`npm link` writes its bin shim to the global prefix bin directory, so that
directory must be on `PATH` for `agent-loop` to resolve. It is the
`npm prefix -g` directory on Windows and `$(npm prefix -g)/bin` on macOS and
Linux.

Entries rendered from a clone point at that clone. After the clone moves, run
`npm link --force` from the new location, then `agent-loop install` again. A
plain `npm link` fails with `EEXIST` on Windows when a shim already exists;
`--force` overwrites the shim.
`pnpm link` is not a supported path: pnpm 12 `link` has no global mode. Without a
link, call the CLI entry directly and quote the repository path so a path with
spaces works:

```bash
node "<repo>/src/cli.mjs" install --harness claude --yes
```

`pnpm agent-loop` still runs the CLI entry from the repository root. The
repository Git hooks run formatting and linting on commit and push; they need
`pnpm install` to have completed, because its `prepare` script installs the
Vite+ hook dispatcher (`vp config`). The hook scripts live in `.vite-hooks/`.
`prepare` exits 0 in CI, in production, with `VP_GIT_HOOKS=0`, and when
`vite-plus` is absent. `prepare` writes nothing to stdout. When the dispatcher
install fails, it writes one warning line to stderr and still exits 0. A clone set up under Husky has a local `core.hooksPath`
that resolves to `<repo>/.husky/_`; `prepare` unsets only that local value, so
`vp config` can install the dispatcher. Any other hooks path, and a value in the
global or system config, stays unchanged.
