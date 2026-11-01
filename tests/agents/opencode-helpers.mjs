// Fixtures shared by the opencode test files.
import { afterEach } from "vite-plus/test";
import { restoreRunsRoot } from "../env-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

export function textEvent(text, messageID) {
  return JSON.stringify({
    type: "text",
    sessionID: "sess-oc",
    part: messageID === undefined ? { text } : { text, messageID },
  });
}

export function errorEvent(error) {
  return JSON.stringify({ type: "error", sessionID: "sess-oc", error });
}

/**
 * Registers the cleanup of the runs root and the paths a dispatch test creates, and returns the
 * list that the test pushes them to.
 */
export function trackDispatchPaths() {
  const dispatchPaths = [];
  afterEach(async () => {
    restoreRunsRoot();
    const paths = dispatchPaths.splice(0);
    // Every registered path is attempted so one failure cannot strand the rest, and the first
    // failure is rethrown so a real cleanup failure still fails the run.
    let firstError;
    for (const path of paths) {
      if (typeof path !== "string") {
        continue;
      }
      try {
        await removePath(path);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) {
      throw firstError;
    }
  });
  return dispatchPaths;
}
