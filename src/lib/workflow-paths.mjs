import { isAlias, parseAllDocuments, visit } from "yaml";
import { isJsonObject } from "./json.mjs";

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);
// A pattern the matcher can settle: word characters, dots, dashes, `@`, `/`, and `*`. Anything else
// (`!`, `?`, `+`, `[`, `{`, `~`, a backslash, a space) is an unsettled pattern.
const SETTLED_PATTERN = /^[A-Za-z0-9_.@/*-]+$/;
// A file name the matcher cannot settle: a control character, a line or paragraph separator, or a
// lone surrogate. GitHub documents no rule for such a name, so it keeps the wait.
// oxlint-disable-next-line no-control-regex -- the control characters are the point of the pattern
const UNSETTLED_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// A text the scan cannot read as plain names: a backslash starts a YAML escape or a line continuation
// that can spell an event name (`"pull_request"`), and a control character, as a NUL in UTF-16 text,
// hides names from the scan.
// oxlint-disable-next-line no-control-regex -- the control characters are the point of the pattern
export const UNREADABLE_TEXT = /[\\\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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
 * under it. A match that GitHub would not make only keeps the wait. With `exact`, the expression is
 * case-sensitive and matches only the paths that the rules match, for a proof that a path is covered.
 */
function patternRegExp(pattern, exact = false) {
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
  return new RegExp(
    `^${source}${exact || pattern.includes("*") ? "" : "(?:/.*)?"}$`,
    exact ? "s" : "is",
  );
}

/** Whether any node of `document` carries a tag or an anchor, whatever its value, or is an alias. */
function hasNodeProperty(document) {
  let found = false;
  visit(document, (_key, node) => {
    if (node && (node.tag !== undefined || node.anchor !== undefined || isAlias(node))) {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return found;
}

/**
 * The one document of `text` as plain data, or null when the text is not exactly one well-formed
 * document, or when any node carries a tag, an anchor, or an alias.
 */
function onlyDocument(text) {
  const documents = parseAllDocuments(text, { uniqueKeys: true, maxAliasCount: 0 });
  if (
    documents.length !== 1 ||
    documents[0].errors.length > 0 ||
    documents[0].warnings.length > 0 ||
    hasNodeProperty(documents[0])
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
  return filterOf(event, "paths");
}

/** Whether `files` holds only strings that the matcher settles. */
const areSettledFiles = (files) =>
  files.every(
    (file) => typeof file === "string" && file.isWellFormed() && !UNSETTLED_NAME.test(file),
  );

/** The settled patterns of the filter `key` of one PR event, or null when it holds no settled list. */
function filterOf(event, key) {
  const list = event[key];
  return Array.isArray(list) && list.length > 0 && list.every(isSettledPattern) ? list : null;
}

/**
 * Whether one filter of the `pull_request` event proves that no run starts for a PR into `base` that
 * changes `files`. The filters combine, so one proof is enough. A `types` filter proves nothing, and
 * neither does a filter with a pattern that the matcher cannot settle.
 */
function eventExcludes(event, files, base) {
  const paths = filterOf(event, "paths");
  const pathsIgnore = filterOf(event, "paths-ignore");
  const branches = filterOf(event, "branches");
  const branchesIgnore = filterOf(event, "branches-ignore");
  const pathsRe = paths?.map((pattern) => patternRegExp(pattern));
  const pathsIgnoreRe = pathsIgnore?.map((pattern) => patternRegExp(pattern, true));
  return (
    (paths !== null && !pathsRe.some((re) => files.some((file) => re.test(file)))) ||
    (pathsIgnore !== null && files.every((file) => pathsIgnoreRe.some((re) => re.test(file)))) ||
    (branches !== null && !branches.some((pattern) => patternRegExp(pattern).test(base))) ||
    (branchesIgnore !== null &&
      branchesIgnore.some((pattern) => patternRegExp(pattern, true).test(base)))
  );
}

/**
 * Whether the text of one workflow file may run for a PR into `base` that changes `files`. False only
 * when the text proves no run starts: it cannot spell `pull_request`, or it is one well-formed YAML
 * document whose `on` key omits `pull_request`, or a `paths`, `paths-ignore`, `branches`, or
 * `branches-ignore` filter of that event excludes the PR (see `eventExcludes`). Every other text is
 * not settled and may run: a syntax error, a second document, a tag, an anchor, an alias, a form of
 * `on` that is not a string, a list, or a map, no file, and a file name that the matcher cannot settle.
 */
export function prWorkflowMayRun(text, files, base) {
  if (!text.includes("pull_request") && !UNREADABLE_TEXT.test(text)) {
    return false;
  }
  const workflow = onlyDocument(text);
  if (
    !isJsonObject(workflow) ||
    "true" in workflow ||
    typeof base !== "string" ||
    files.length === 0 ||
    !areSettledFiles(files)
  ) {
    return true;
  }
  const on = workflow.on;
  if (typeof on === "string") {
    return on === "pull_request";
  }
  if (Array.isArray(on)) {
    return !on.every((name) => typeof name === "string") || on.includes("pull_request");
  }
  if (!isJsonObject(on)) {
    return true;
  }
  if (!("pull_request" in on)) {
    return false;
  }
  const event = on.pull_request;
  return !isJsonObject(event) || !eventExcludes(event, files, base);
}

/**
 * Whether no workflow run can start for a PR that changes `files` (every path as a string, renamed-from
 * paths included), judged from the text of one workflow file: true only when the text is exactly one
 * well-formed YAML document whose `on` key names only `pull_request` and `pull_request_target`, each
 * with a `paths` list of settled patterns, and no file matches any pattern. False means a run may
 * start or the text is not settled, so the caller keeps the wait. A text with a syntax error anywhere,
 * a second document, a duplicate key, a tag, an anchor, an alias, or a warning is not settled, and neither is a file name
 * with a control character, a line separator, or a lone surrogate.
 */
export function prEventsFilteredOut(text, files) {
  if (!areSettledFiles(files)) {
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
      !patterns
        .map((pattern) => patternRegExp(pattern))
        .some((re) => files.some((file) => re.test(file)))
    );
  });
}
