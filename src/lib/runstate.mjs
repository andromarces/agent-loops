// Lifecycle state file shared by the role subcommand (#55) and the parent
// guard hook (#57). The state file lives at a fixed path derived from the
// resolved work tree cwd, never passed as a flag; tests override the runs
// root with AGENT_LOOP_RUNS_ROOT.
//
// One parent session can drive several concurrent runs, one per work tree. Init
// registers each run as its own entry file at
// `<root>/session-runs/<parent-session>/<cwd hash>` (the state directory name),
// so simultaneous inits in different work trees never overwrite each other. The
// guard reads every entry under that directory and denies if any resolves to a
// non-terminal run owned by the hook session. The reader also unions the legacy
// single-file index at `<root>/sessions/<parent-session>`; init never writes it,
// and the directory name avoids a file-versus-directory clash at that path.
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mapInBatches } from "./batches.mjs";
import { sha256 } from "./hash.mjs";
import { tmpRoot } from "./tmp-root.mjs";
import { isJsonObject } from "./json.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";

// State files that one batch of reads handles at once.
const READ_BATCH_SIZE = 32;

export const TERMINAL_LIFECYCLES = new Set(["halted", "finished", "aborted"]);

/**
 * Resolve the state paths for one run. `cwd` derives the per-work-tree state
 * directory; `parentSession` derives the session-run entry directory and the
 * legacy index file that the #57 hook reads back. Both are optional so a caller
 * with only one of them still resolves the half it needs. `sessionEntryFile` is
 * present only when both are given.
 * @param {{ cwd?: string, parentSession?: string }} args
 * @returns {{ root: string, stateDir?: string, stateFile?: string, lockFile?: string, sessionEntryFile?: string, sessionRunsDir?: string, legacyIndexFile?: string }}
 */
export function statePaths({ cwd, parentSession } = {}) {
  const root = stateRoot();
  const paths = { root };

  if (parentSession !== undefined) {
    assertSessionId(parentSession);
  }

  if (cwd !== undefined) {
    const stateDirName = cwdHash(cwd);
    const stateDir = join(root, stateDirName);
    paths.stateDir = stateDir;
    paths.stateFile = join(stateDir, "state.json");
    paths.lockFile = join(stateDir, "state.lock");
    if (parentSession !== undefined) {
      paths.sessionEntryFile = join(root, "session-runs", parentSession, stateDirName);
    }
  }

  if (parentSession !== undefined) {
    paths.sessionRunsDir = join(root, "session-runs", parentSession);
    paths.legacyIndexFile = join(root, "sessions", parentSession);
  }

  return paths;
}

/** The directory of all run state: `AGENT_LOOP_RUNS_ROOT`, else `<os tmpdir>/agent-loops/runs`. */
export const stateRoot = () => tmpRoot("AGENT_LOOP_RUNS_ROOT", "runs");

/**
 * The name of the state directory of the run in one work tree, which is also the key that binds
 * a spawned child to its run (issue #392). It hashes the lexical path, so a path spelling that
 * the state lookup treats as another run is another key and finds no state.
 */
export function cwdHash(cwd) {
  return sha256(canonicalCwd(cwd)).slice(0, 12);
}

function canonicalCwd(cwd) {
  const resolved = resolve(cwd);
  // Windows drive letters compare case-insensitively in the filesystem but
  // not in the hash; normalize the letter so `c:\repo` and `C:\repo` share one
  // state directory.
  return resolved.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
}

// A parent session id is one path segment under <root>/session-runs and under
// the legacy <root>/sessions, and is matched verbatim against the harness
// session id by the #57 guard. Real harness ids
// are opaque tokens, but an unexpanded template (`${CLAUDE_SESSION_ID}`,
// `%CODEX_THREAD_ID%`, `<parent-session-id>`), a path separator, or whitespace
// can only come from a caller that failed to expand its placeholder. Any of
// them would register a run whose parent never matches, so refuse all of them
// before a state file exists. A bare placeholder name with no punctuation
// (`CLAUDE_SESSION_ID`) is indistinguishable from a real token here; only a
// harness-id allowlist would catch it, which ADR 0006 rejects.
const SESSION_ID_FORBIDDEN = /[\\/\0\s$`{}%<>]/;

function assertSessionId(sessionId) {
  if (
    !sessionId ||
    sessionId === "." ||
    sessionId === ".." ||
    SESSION_ID_FORBIDDEN.test(sessionId)
  ) {
    throw new Error(`Invalid session id: ${JSON.stringify(sessionId ?? null)}`);
  }
}

/**
 * Reads every state file registered by a parent session id and returns the
 * parsed states that are readable. Unions the per-run entry directory with the
 * legacy single-path index. A missing, unreadable, or corrupt entry or state
 * file is skipped, never thrown: the #57 hook treats an empty list as
 * unguarded, and one corrupt run never hides another active run.
 * @returns {Promise<object[]>}
 */
export async function readStatesForSession(parentSession) {
  const { sessionRunsDir, legacyIndexFile } = statePaths({ parentSession });
  const stateFiles = await readSessionEntryPaths(sessionRunsDir, legacyIndexFile);
  const states = await Promise.all(
    stateFiles.map((stateFile) => readState(stateFile).catch(() => null)),
  );
  // An absent, unreadable, corrupt, or non-object state file reads as null and never denies on its own.
  return states.filter((state) => state !== null);
}

// Collects the state file path from every entry file in the new directory and
// from the legacy single-path index. An entry that cannot be read is skipped,
// and a temp file left by an interrupted atomic write is not an entry.
async function readSessionEntryPaths(sessionRunsDir, legacyIndexFile) {
  const stateFiles = [];
  try {
    const names = (await readdir(sessionRunsDir)).filter((name) => !name.endsWith(".tmp"));
    const texts = await Promise.all(
      names.map((name) => readFile(join(sessionRunsDir, name), "utf8").catch(() => null)),
    );
    // An unreadable entry reads as null and is skipped.
    stateFiles.push(...texts.filter((text) => text !== null).map((text) => text.trim()));
  } catch {
    // No entry directory: every run predates the new format or none registered.
  }
  try {
    stateFiles.push((await readFile(legacyIndexFile, "utf8")).trim());
  } catch {
    // No legacy entry.
  }
  return stateFiles.filter((stateFile) => stateFile !== "");
}

/**
 * Reads and parses the state file. Returns null when absent; a corrupt file
 * throws so the caller exits instead of guessing the lifecycle.
 */
export async function readState(stateFile) {
  let text;
  try {
    text = await readFile(stateFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const value = JSON.parse(text);
  if (!isJsonObject(value)) {
    throw new Error(`State file is not a JSON object: ${stateFile}`);
  }
  return value;
}

/**
 * The claude role sessions that the current and the archived state files of one work tree record,
 * as `{ role, sessionId }` entries (#673). The pre-spawn write of a turn puts the id there before
 * the CLI starts, so a hard kill still leaves it. An unreadable or malformed file is skipped.
 * known-limit: every archived file is read, so a work tree with many earlier runs reads them all.
 */
export async function readClaudeSessions(stateDir) {
  let names;
  try {
    names = await readdir(stateDir);
  } catch {
    return [];
  }
  const entries = [];
  const files = names.filter((n) => /^state(\..+)?\.json$/.test(n));
  const rolesOfFiles = await mapInBatches(files, READ_BATCH_SIZE, (name) =>
    readState(join(stateDir, name)).then(
      (state) => state?.roles,
      () => undefined,
    ),
  );
  for (const roles of rolesOfFiles) {
    for (const [role, state] of Object.entries(isJsonObject(roles) ? roles : {})) {
      if (isJsonObject(state) && state.kind === "claude" && typeof state.sessionId === "string") {
        entries.push({ role, sessionId: state.sessionId });
      }
    }
  }
  return entries;
}

export async function writeState(stateFile, state) {
  await writeFileAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Writes one run's entry under the parent session's entry directory. The entry
 * name is the state directory name, so a re-init in the same work tree
 * overwrites its own entry while a concurrent init in another work tree writes
 * a different file. The per-cwd state lock serializes the same-work-tree case,
 * and the atomic rename keeps a concurrent guard from reading a partial entry.
 */
export async function writeSessionEntry(entryFile, stateFile) {
  await mkdir(dirname(entryFile), { recursive: true });
  return writeFileAtomic(entryFile, `${stateFile}\n`);
}
