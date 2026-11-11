// The one `gh` JSON read for batch callers. Each caller maps the `kind` of a failed read to its
// own message, so a shared reader never changes an outcome.
/**
 * Runs one `gh` read and returns the parsed JSON of a successful reply. A failed read throws an
 * error whose `kind` is `empty`, `timeout`, `status`, or `json`. `options` is forwarded to `gh`.
 */
export async function readGhJson(gh, args, cwd, options) {
  const reply = await gh(args, cwd, options);
  if (reply?.timedOut === true) {
    throw Object.assign(new Error("the read reached its bound"), { kind: "timeout", reply });
  }
  if (reply === undefined || reply === null) {
    throw Object.assign(new Error("the read returned nothing"), { kind: "empty", reply });
  }
  if (reply.status !== 0) {
    throw Object.assign(new Error((reply.stderr ?? "").trim() || `exit ${reply.status}`), {
      kind: "status",
      reply,
    });
  }
  try {
    return JSON.parse(reply.stdout);
  } catch (err) {
    throw Object.assign(new Error(err.message), { kind: "json", reply });
  }
}
