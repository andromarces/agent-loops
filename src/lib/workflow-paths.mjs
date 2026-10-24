const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);
// A pattern the matcher can settle: word characters, dots, dashes, `@`, `/`, and `*`. Anything else
// (`!`, `?`, `+`, `[`, `{`, `~`, a backslash, a space) is an unsettled pattern.
const SETTLED_PATTERN = /^[A-Za-z0-9_.@/*-]+$/;

/** The text of one `paths` item when it is a settled pattern, else null. */
function settledPattern(raw) {
  const quoted = /^'([^']*)'$/.exec(raw) ?? /^"([^"\\]*)"$/.exec(raw);
  const value = quoted ? quoted[1] : raw;
  if (!quoted && (/^[!&*[\]{}|>%@`'"?,:#-]/.test(value) || /:(?:\s|$)/.test(value))) {
    return null;
  }
  const segments = value.split("/");
  if (
    !SETTLED_PATTERN.test(value) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return value;
}

/**
 * A case-insensitive regular expression that matches every path that GitHub filter rules match for
 * `pattern`, and at most a few more: `*` stays inside one segment, `**` crosses segments, `**` plus a
 * slash may match nothing, and a pattern with no `*` also matches the files under it. A match that
 * GitHub would not make only keeps the wait.
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
  return new RegExp(`^${source}${pattern.includes("*") ? "" : "(?:/.*)?"}$`, "i");
}

/** The lines of `text` as `{ indent, content }` entries with comments and blank lines dropped; null when unreadable. */
function contentLines(text) {
  if (text.includes("\t")) {
    return null;
  }
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    let content = trimmed;
    if (/\s#/.test(content)) {
      // A comment after a whole quoted item is cut; a `#` beside any other quote is unsettled.
      const quotedItem = /^(- (?:'[^']*'|"[^"\\]*"))\s+#.*$/.exec(content);
      if (!quotedItem && /['"]/.test(content)) {
        return null;
      }
      content = quotedItem ? quotedItem[1] : content.replace(/\s+#.*$/, "");
    }
    const indent = line.length - line.trimStart().length;
    if (lines.length === 0 && indent === 0 && content === "---") {
      continue;
    }
    lines.push({ indent, content });
  }
  return lines;
}

/** The `paths` patterns under one PR event, or null when the event holds no settled `paths` list. */
function pathsOf(children) {
  const childIndent = children[0]?.indent;
  let patterns = null;
  let inPaths = false;
  let itemIndent = null;
  for (const { indent, content } of children) {
    if (indent < childIndent) {
      return null;
    }
    const isItem = content.startsWith("- ");
    if (indent === childIndent && !isItem) {
      const key = /^([A-Za-z_-]+):(.*)$/.exec(content);
      if (key === null || key[1] === "paths-ignore") {
        return null;
      }
      inPaths = key[1] === "paths";
      if (inPaths) {
        if (patterns !== null || key[2].trim() !== "") {
          return null;
        }
        patterns = [];
      }
    } else if (inPaths) {
      itemIndent ??= indent;
      const pattern =
        isItem && indent === itemIndent ? settledPattern(content.slice(2).trim()) : null;
      if (pattern === null) {
        return null;
      }
      patterns.push(pattern);
    }
  }
  return patterns !== null && patterns.length > 0 ? patterns : null;
}

/**
 * Whether no workflow run can start for a PR that changes `files` (paths, renamed-from paths included),
 * judged from the text of one workflow file: true only when the file has one top-level `on:` block in
 * plain block YAML that names only `pull_request` and `pull_request_target`, each with a `paths` list
 * of settled patterns, and no file matches any pattern. False means a run may start or the text is
 * not settled, so the caller keeps the wait. The text is not parsed as full YAML: any shape outside
 * the plain block form returns false.
 */
export function prEventsFilteredOut(text, files) {
  const lines = contentLines(text);
  if (lines === null) {
    return false;
  }
  const onKeys = lines.filter(
    ({ indent, content }) => indent === 0 && /^(?:on|"on"|'on'|true)\s*:/i.test(content),
  );
  if (onKeys.length !== 1 || onKeys[0].content !== "on:") {
    return false;
  }
  const start = lines.indexOf(onKeys[0]) + 1;
  const next = lines.findIndex(({ indent }, i) => i >= start && indent === 0);
  const block = lines.slice(start, next === -1 ? lines.length : next);
  if (block.length === 0) {
    return false;
  }
  const eventIndent = block[0].indent;
  const events = new Map();
  let current = null;
  for (const line of block) {
    if (line.indent < eventIndent) {
      return false;
    }
    if (line.indent > eventIndent) {
      current.push(line);
      continue;
    }
    const name = /^([a-z_]+):$/.exec(line.content)?.[1];
    if (name === undefined || !PR_EVENTS.has(name) || events.has(name)) {
      return false;
    }
    current = [];
    events.set(name, current);
  }
  for (const children of events.values()) {
    const patterns = pathsOf(children);
    if (
      patterns === null ||
      patterns.some((pattern) => files.some((file) => patternRegExp(pattern).test(file)))
    ) {
      return false;
    }
  }
  return true;
}
