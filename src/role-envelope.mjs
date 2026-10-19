// The JSON envelope of `agent-loop role`: the error result for a thrown value and the stdout write.
import { writeSync } from "node:fs";
import { errorMessage, redactedText, readProp, UNREADABLE_MESSAGE } from "./lib/error-message.mjs";

/** One error envelope for a thrown value. A cancel keeps exit 130. */
export function errorResult(err) {
  // A cancel outside the turn `try` block, such as the process-table read of a resume or an init (#725).
  if (readProp(err, "isCanceled")) {
    return { exitCode: 130, payload: { status: "error", error: "Interrupted by SIGINT" } };
  }
  try {
    // A wait that failed with a `gh` child whose exit it never observed says so, so the parent
    // settles that process before it starts another wait.
    return {
      exitCode: 1,
      payload: {
        status: "error",
        error: errorMessage(err),
        ...(readProp(err, "childExitUnconfirmed") === true ? { childExitUnconfirmed: true } : {}),
      },
    };
  } catch (formatErr) {
    // Reading the message threw. Keep one envelope, and keep a cancel as exit 130.
    const canceled = Boolean(readProp(formatErr, "isCanceled"));
    return {
      exitCode: canceled ? 130 : 1,
      payload: {
        status: "error",
        error: canceled ? "Interrupted by SIGINT" : UNREADABLE_MESSAGE,
      },
    };
  }
}

/**
 * Writes the envelope as one stdout line and sets the exit code. A failed write
 * cannot be retried on the same stream, so it is reported on stderr and turns a
 * zero exit code into 1; any other exit code, such as 130, is kept. `console.log` swallows a write error, so the write
 * callback is the only place the failure shows.
 */
export async function printEnvelope(payload, exitCode) {
  let line;
  try {
    line = JSON.stringify(payload);
  } catch {
    line = JSON.stringify({ status: "error", error: "Unserializable envelope" });
    exitCode ||= 1;
  }
  // Node also emits a failed write as a stream 'error' event after the callback. With no
  // listener that event crashes the process, so one stays until the event queue drains.
  const consume = () => {};
  process.stdout.on("error", consume);
  const failure = await new Promise((resolve) => {
    try {
      process.stdout.write(`${line}\n`, resolve);
    } catch (err) {
      resolve(err);
    }
  });
  setImmediate(() => process.stdout.off("error", consume));
  process.exitCode = exitCode;
  if (failure) {
    console.error(
      redactedText(
        `Failed to write the envelope to stdout: ${redactedText(readProp(failure, "code") ?? readProp(failure, "message"))}`,
      ),
    );
    process.exitCode ||= 1;
  }
}

/**
 * Writes all of `text` to `fd` with `writeSync`. It continues after a partial write and retries
 * `EAGAIN` (a non-blocking pipe that is full) for at most 2 s, then throws. A text shorter than
 * `PIPE_BUF` (4096 bytes) reaches a pipe whole or not at all, so the cancel envelope never lands
 * cut there. Any other failure throws.
 */
export function writeAllSync(fd, text) {
  const buffer = Buffer.from(text);
  const deadline = Date.now() + 2000;
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if (err?.code !== "EAGAIN" || Date.now() > deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
