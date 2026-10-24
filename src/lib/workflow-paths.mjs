import { parseAllDocuments } from "yaml";
import { isJsonObject } from "./json.mjs";

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);
// A pattern the matcher can settle: word characters, dots, dashes, `@`, `/`, and `*`. Anything else
// (`!`, `?`, `+`, `[`, `{`, `~`, a backslash, a space) is an unsettled pattern.
const SETTLED_PATTERN = /^[A-Za-z0-9_.@/*-]+$/;
// A file name the matcher cannot settle: a control character, a line or paragraph separator, or a
// lone surrogate. GitHub documents no rule for such a name, so it keeps the wait.
// oxlint-disable-next-line no-control-regex -- the control characters are the point of the pattern
const UNSETTLED_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Whether `value` is a pattern string that the matcher settles. */
function isSettledPattern(value) {
  return (
    typeof value === "string" &&
    SETTLED_PATTERN.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

/**
 * A case-insensitive regular expression that matches every path that GitHub filter rules match for
 * `pattern`, and at most a few more: `*` stays inside one segment, `**` crosses segments and any
 * character, `**` plus a slash may match nothing, and a pattern with no `*` also matches the files
 * under it. A match that GitHub would not make only keeps the wait.
 */
function patternRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length;) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else {
      source += pattern[i] === "." ? "\\." : pattern[i];
      i += 1;
    }
  }
  return new RegExp(`^${source}${pattern.includes("*") ? "" : "(?:/.*)?"}$`, "is");
}

/** The one document of `text` as plain data, or null when the text is not exactly one well-formed document. */
function onlyDocument(text) {
  const documents = parseAllDocuments(text, { uniqueKeys: true, maxAliasCount: 0 });
  if (
    documents.length !== 1 ||
    documents[0].errors.length > 0 ||
    documents[0].warnings.length > 0
  ) {
    return null;
  }
  try {
    return documents[0].toJS({ maxAliasCount: 0 });
  } catch {
    return null;
  }
}

/** The `paths` patterns of one PR event, or null when the event holds no settled `paths` list. */
function pathsOf(event) {
  if (!isJsonObject(event) || "paths-ignore" in event || !Array.isArray(event.paths)) {
    return null;
  }
  return event.paths.length > 0 && event.paths.every(isSettledPattern) ? event.paths : null;
}

/**
 * Whether no workflow run can start for a PR that changes `files` (every path as a string, renamed-from
 * paths included), judged from the text of one workflow file: true only when the text is exactly one
 * well-formed YAML document whose `on` key names only `pull_request` and `pull_request_target`, each
 * with a `paths` list of settled patterns, and no file matches any pattern. False means a run may
 * start or the text is not settled, so the caller keeps the wait. A text with a syntax error anywhere,
 * a second document, a duplicate key, an alias, or a warning is not settled, and neither is a file name
 * with a control character, a line separator, or a lone surrogate.
 */
export function prEventsFilteredOut(text, files) {
  if (
    !files.every(
      (file) => typeof file === "string" && file.isWellFormed() && !UNSETTLED_NAME.test(file),
    )
  ) {
    return false;
  }
  const workflow = onlyDocument(text);
  if (!isJsonObject(workflow) || "true" in workflow || !isJsonObject(workflow.on)) {
    return false;
  }
  const events = Object.entries(workflow.on);
  if (events.length === 0 || events.some(([name]) => !PR_EVENTS.has(name))) {
    return false;
  }
  return events.every(([, event]) => {
    const patterns = pathsOf(event);
    return (
      patterns !== null &&
      !patterns.some((pattern) => files.some((file) => patternRegExp(pattern).test(file)))
    );
  });
}
