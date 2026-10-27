import { randomUUID } from "node:crypto";
import { writeFileAtomic, writeFileAtomicSync } from "./atomic-write.mjs";
import { readableErrorText, readProp, redactedText } from "./error-message.mjs";
import { sha256 } from "./hash.mjs";
import { logWarn } from "./log.mjs";
import {
  isInside,
  removeSessionRecord,
  sessionRecordPath,
  writeSessionRecord,
} from "./session-record.mjs";
import { workTreeRoot } from "./snapshot.mjs";
import { redactCommandText } from "./test-cmd.mjs";

/**
 * Owns the transcript data and every write of it: the file, the force-exit write, and the
 * pre-spawn session record. The `data` object is mutated by the caller to record the outcome.
 */
export function createTranscriptWriter({ options, roles, events, reviewerSandbox, signal }) {
  // The mode is recorded only when the run named one, so a mode-free run writes
  // the transcript shape it wrote before the flag existed, and a consumer of that file sees no
  // field this flag introduced (#337).
  const transcriptData = {
    task: options.task,
    cwd: options.cwd,
    options: {
      maxSteps: options.maxSteps,
      timeout: options.timeout,
      requireAccept: options.requireAccept,
      pr: options.pr,
      requireCi: options.requireCi,
      ...(options.compareHead === null ? {} : { compareHead: options.compareHead }),
      ...(options.testCmd === null
        ? {}
        : {
            testCmd: redactCommandText(options.testCmd),
            testCmdTimeout: options.testCmdTimeout,
          }),
      ...(reviewerSandbox === null ? {} : { reviewerSandbox }),
      ...(options.mode === null ? {} : { mode: options.mode }),
      ...(options.continueFrom ? { continueFrom: options.continueFrom } : {}),
      ...(options.copyLocalFiles ? {} : { copyLocalFiles: false }),
    },
    roles,
    events,
    exitCode: 1,
    error: null,
  };

  // The pre-assigned session id of the turn that is running, with the mark that no CLI output
  // confirmed it. It exists only in the written record, never on the role state, so the adapter
  // alone decides what a failed turn keeps (issue #564). Cleared when the CLI call ends.
  let pendingSession = null;

  // The digest of the transcript file that this run wrote last. A session record binds to it.
  let transcriptDigest = null;

  // A transcript write supersedes the session record of the file, so it removes the record.
  const transcriptText = () => {
    const { role, id } = pendingSession ?? {};
    const data = pendingSession
      ? {
          ...transcriptData,
          roles: {
            ...roles,
            [role]: { ...roles[role], sessionId: id, sessionUnconfirmed: true },
          },
        }
      : transcriptData;
    return JSON.stringify(data, null, 2);
  };
  const writeTranscript = async () => {
    if (!options.transcript) return;
    try {
      const text = transcriptText();
      // Atomic, because the file can be the --continue-from source: a crash or a
      // failed write must leave the earlier record whole.
      await writeFileAtomic(options.transcript, text);
      transcriptDigest = sha256(text);
      await removeSessionRecord(options.transcript);
    } catch (err) {
      console.error(
        redactedText(
          `Warning: Failed to write transcript to ${options.transcript}: ${redactedText(readProp(err, "message"))}`,
        ),
      );
    }
  };

  // A second SIGINT writes the transcript as the run holds it, with exit 130. The write is
  // synchronous and skips the session-record removal, which is async (ADR 0033).
  const writeOnForceExit = () => {
    if (!options.transcript) return;
    transcriptData.exitCode = 130;
    transcriptData.error = "Interrupted by SIGINT";
    writeFileAtomicSync(options.transcript, transcriptText());
  };

  // The orchestrator and the reviewer run under the mutation check, which covers the whole Git work
  // tree, not only --cwd, so a transcript inside that tree cannot be written during their turn. Their
  // pre-spawn save then goes to a session record outside the tree, and --continue-from reads it
  // (ADR 0027). The mode is "file" (write the transcript), "record" (write the record), or "none"
  // (no safe place: a root that cannot be read, or a record location inside the tree).
  const runNonce = randomUUID();
  let saveMode = "file";
  const chooseSaveMode = async () => {
    try {
      const root = await workTreeRoot(options.cwd, { signal });
      if (!(await isInside(root, options.transcript))) return saveMode;
      saveMode = (await isInside(root, await sessionRecordPath(options.transcript)))
        ? "none"
        : "record";
      if (saveMode === "record") transcriptData.runNonce = runNonce;
    } catch (err) {
      // A cancel ends the run as canceled, and the caller's catch keeps exit 130.
      if (readProp(err, "isCanceled")) throw err;
      saveMode = "none";
    }
    return saveMode;
  };
  const onSessionAssigned = async (role, id) => {
    if (role === "worker" || saveMode === "file") {
      pendingSession = id ? { role, id } : null;
      await writeTranscript();
      return;
    }
    // A withdrawn id leaves the transcript as it is, which holds no id for the role.
    if (!id) {
      await removeSessionRecord(options.transcript);
      return;
    }
    if (saveMode === "record" && transcriptDigest !== null) {
      try {
        await writeSessionRecord(options.transcript, {
          cwd: options.cwd,
          runNonce,
          transcriptSha256: transcriptDigest,
          role,
          sessionId: id,
        });
        return;
      } catch (err) {
        logWarn(`${role}: the session record was not written: ${readableErrorText(err)}`);
      }
    }
    logWarn(
      `${role}: the session id is not saved before the turn, because --transcript is inside the work tree and no record location outside it is usable.`,
    );
  };

  return {
    data: transcriptData,
    writeTranscript,
    writeOnForceExit,
    chooseSaveMode,
    onSessionAssigned,
    clearPendingSession: () => {
      pendingSession = null;
    },
  };
}
