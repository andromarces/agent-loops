import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

// npm ships these root files even when the `files` allowlist omits them.
const ALWAYS_SHIPPED = ["README.md", "package.json", "LICENSE", "LICENCE"];

const toPosix = (path) => path.split(sep).join("/");

/** Lists every file under `dir` as an absolute path. */
async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(absolute)));
    else if (entry.isFile()) found.push(absolute);
  }
  return found;
}

/**
 * Resolves the plain directory, file, and negation entries of a `files`
 * allowlist to the set of shipped paths. Returns repo-relative posix paths.
 */
async function shippedFiles(entries) {
  const included = entries.filter((entry) => !entry.startsWith("!"));
  const excluded = entries.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
  const files = new Set();
  for (const entry of ALWAYS_SHIPPED) {
    const details = await stat(join(root, entry)).catch(() => undefined);
    if (details?.isFile()) files.add(entry);
  }
  for (const entry of included) {
    const absolute = join(root, entry);
    const details = await stat(absolute);
    if (details.isDirectory()) {
      for (const file of await walk(absolute)) files.add(toPosix(relative(root, file)));
    } else {
      files.add(toPosix(entry));
    }
  }
  for (const entry of excluded) {
    const prefix = entry.replace(/\/$/, "");
    for (const file of files) {
      if (file === prefix || file.startsWith(`${prefix}/`)) files.delete(file);
    }
  }
  return files;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Removes block quote markers from a line. */
function stripQuotes(line) {
  let text = line;
  for (;;) {
    const match = /^ {0,3}>[ \t]?/.exec(text);
    if (!match) return text;
    text = text.slice(match[0].length);
  }
}

/** Returns a list item line without its marker, with the content indent. */
function listItem(line) {
  const match = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line);
  if (!match) return { text: line, baseIndent: 0 };
  return {
    text: match[4],
    baseIndent: match[1].length + match[2].length + match[3].length,
  };
}

/** Returns a continuation line without quotes and the list content indent. */
function continuationLine(line, baseIndent) {
  if (line === undefined || line.trim() === "") return "";
  let text = stripQuotes(line);
  let spaces = 0;
  while (spaces < baseIndent && text[spaces] === " ") spaces += 1;
  return text.slice(spaces);
}

/** Returns the offset after up to three leading spaces. */
function indentOffset(text) {
  return /^ {0,3}/.exec(text)[0].length;
}

/** Returns the offset after whitespace. */
function spaceOffset(text) {
  return /^[ \t]*/.exec(text)[0].length;
}

/** Returns true when `char` opens a title. */
function isTitleStart(char) {
  return char === '"' || char === "'" || char === "(";
}

/** Finds the first unescaped closing bracket and checks the colon after it. */
function labelEnd(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text[index] === "]") {
      return { end: index, definition: text[index + 1] === ":" };
    }
  }
  return undefined;
}

/** Resolves backslash escapes in a destination. */
function unescape(text) {
  return text.replace(/\\(.)/g, "$1");
}

/** Reads a bare or angle-bracket destination at `start`. */
function scanDestination(text, start) {
  if (text[start] === "<") {
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === "\\") {
        index += 1;
      } else if (text[index] === "<") {
        return undefined;
      } else if (text[index] === ">") {
        return { destination: unescape(text.slice(start + 1, index)), end: index + 1 };
      }
    }
    return undefined;
  }
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === " " || char === "\t") break;
    if (char === "(") depth += 1;
    if (char === ")") {
      if (depth === 0) return undefined;
      depth -= 1;
    }
    index += 1;
  }
  if (index === start || depth !== 0) return undefined;
  return { destination: unescape(text.slice(start, index)), end: index };
}

/** Reads a title that starts at `start`, across lines, and returns its end. */
function scanTitle(lines, lineIndex, lineText, start, baseIndent) {
  const open = lineText[start];
  if (!isTitleStart(open)) return undefined;
  const close = open === "(" ? ")" : open;
  let text = lineText;
  let index = lineIndex;
  let offset = start + 1;
  for (;;) {
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
      } else if (text[offset] === close) {
        return text.slice(offset + 1).trim() === "" ? { nextIndex: index } : undefined;
      } else {
        offset += 1;
      }
    }
    const next = continuationLine(lines[index + 1], baseIndent);
    if (next.trim() === "") return undefined;
    index += 1;
    text = next;
    offset = 0;
  }
}

/** Returns true when `line` closes the fence opened by `marker`. */
function closesFence(line, marker) {
  const match = FENCE_CLOSE.exec(line);
  return Boolean(match && match[1][0] === marker[0] && match[1].length >= marker.length);
}

/** Reads one reference definition and returns its target and last line. */
function readDefinition(lines, index) {
  const first = listItem(stripQuotes(lines[index]));
  if (!/^ {0,3}\[/.test(first.text)) return undefined;

  let end = index;
  let labelText = first.text;
  let label = labelEnd(labelText);
  while (label === undefined) {
    const next = continuationLine(lines[end + 1], first.baseIndent);
    if (next.trim() === "") return undefined;
    end += 1;
    labelText += `\n${next}`;
    label = labelEnd(labelText);
  }
  if (!label.definition) return undefined;

  const rest = labelText.slice(label.end + 2);
  const offset = spaceOffset(rest);
  let destination;
  let destinationLine = end;
  let after;
  if (offset < rest.length) {
    const scanned = scanDestination(rest, offset);
    if (scanned === undefined) return undefined;
    destination = scanned.destination;
    after = rest.slice(scanned.end);
  } else {
    const next = continuationLine(lines[end + 1], first.baseIndent);
    if (next.trim() === "") return undefined;
    const nextOffset = indentOffset(next);
    const scanned = scanDestination(next, nextOffset);
    if (scanned === undefined) return undefined;
    end += 1;
    destinationLine = end;
    destination = scanned.destination;
    after = next.slice(scanned.end);
  }

  const trailingOffset = spaceOffset(after);
  if (trailingOffset < after.length) {
    const title = scanTitle(lines, destinationLine, after, trailingOffset, first.baseIndent);
    if (title === undefined) return undefined;
    end = title.nextIndex;
  } else {
    const next = continuationLine(lines[end + 1], first.baseIndent);
    if (next.trim() !== "") {
      const titleOffset = indentOffset(next);
      if (isTitleStart(next[titleOffset])) {
        const title = scanTitle(lines, end + 1, next, titleOffset, first.baseIndent);
        if (title !== undefined) end = title.nextIndex;
      }
    }
  }
  return { target: destination, endIndex: end };
}

/**
 * Returns the targets of reference-style link definitions in a Markdown text.
 * A definition allows up to three leading spaces, then `[label]:`, then a bare
 * or angle-bracket destination. A destination or title can sit on the next
 * line. Four-space indents and fenced code blocks are not definitions.
 */
function definitionTargets(text) {
  const targets = [];
  const lines = text.split(/\r?\n/);
  let fence;
  let fenceIndent = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (fence) {
      const line = continuationLine(lines[index], fenceIndent);
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const item = listItem(stripQuotes(lines[index]));
    const opening = FENCE_OPEN.exec(item.text);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = opening[1];
      fenceIndent = item.baseIndent;
      continue;
    }
    const definition = readDefinition(lines, index);
    if (definition === undefined) continue;
    targets.push(definition.target);
    index = definition.endIndex;
  }
  return targets;
}

/** Returns the inline link and reference definition targets of a Markdown text. */
function linkTargets(text) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(text))) targets.push(match[1].replace(/^<|>$/g, ""));
  targets.push(...definitionTargets(text));
  return targets;
}

/**
 * Returns one message per relative link in `documents` whose target is not in
 * `shipped`. Absolute URLs and same-file anchors pass.
 */
function findUnshippedLinks(documents, shipped) {
  const problems = [];
  for (const { path, text } of documents) {
    for (const target of linkTargets(text)) {
      if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const pathOnly = target.split("#")[0].split("?")[0];
      if (!pathOnly) continue;
      const resolved = toPosix(normalize(join(dirname(path), pathOnly)));
      if (resolved === ".." || resolved.startsWith("../")) {
        problems.push(`${path}: ${target} leaves the package`);
      } else if (!shipped.has(resolved)) {
        problems.push(`${path}: ${target} is not shipped (${resolved})`);
      }
    }
  }
  return problems;
}

// Requirement: no shipped Markdown file links to a path outside the package.
// Usefulness: verifies every relative link resolves to a shipped file, so a
// shipped file cannot break with a link such as ../../adr/. No other check reads
// the links of the shipped Markdown files against the `files` allowlist.
test("every relative link in a shipped Markdown file resolves to a shipped file", async () => {
  const { files = [] } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const shipped = await shippedFiles(files);
  const paths = [...shipped].filter((path) => path.endsWith(".md"));
  const documents = await Promise.all(
    paths.map(async (path) => ({ path, text: await readFile(join(root, path), "utf8") })),
  );
  const problems = findUnshippedLinks(documents, shipped);
  expect(problems, `Unshipped links in shipped Markdown files:\n${problems.join("\n")}`).toEqual(
    [],
  );
});

// Requirement: the link check fails on a link that the package does not ship.
// Usefulness: covers the detector itself on a known-bad document, so a broken
// matcher cannot make the real-file test pass. The passing cases are the forms
// the shipped files use: an absolute URL, a same-file anchor, and a shipped sibling.
test("the link check flags a relative target that the package does not ship", () => {
  const shipped = new Set(["docs/a.md", "docs/b.md", "README.md"]);
  const documents = [
    {
      path: "docs/a.md",
      text: [
        "[ADR](../../adr/0001-hybrid-orchestrator-runtime.md)",
        "[site](https://example.com/x.md)",
        "[here](#section)",
        "[readme](../README.md)",
        "[sibling](b.md#part)",
        "[missing](c.md)",
      ].join("\n"),
    },
    { path: "README.md", text: "[ADR](adr/0001-hybrid-orchestrator-runtime.md)" },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([
    "docs/a.md: ../../adr/0001-hybrid-orchestrator-runtime.md leaves the package",
    "docs/a.md: c.md is not shipped (docs/c.md)",
    "README.md: adr/0001-hybrid-orchestrator-runtime.md is not shipped (adr/0001-hybrid-orchestrator-runtime.md)",
  ]);
});

// Requirement: a reference definition to an unshipped path fails the link check.
// Usefulness: covers the definition reader on a known-bad document, so a missing
// reader cannot let a broken packaged link pass. Every supported form must fail
// here when the reader breaks.
test("the link check flags a reference definition that the package does not ship", () => {
  const shipped = new Set(["docs/a.md", "docs/b.md", "README.md"]);
  const documents = [
    {
      path: "docs/a.md",
      text: [
        "[adr]: ../../adr/0001-hybrid-orchestrator-runtime.md",
        "[missing]: c.md",
        '[double]: missing-double.md "Double"',
        "[single]: missing-single.md 'Single'",
        "[paren]: missing-paren.md (Paren)",
        '[escaped]: missing-escaped.md "A \\"quoted\\" title"',
        "[wrapped]:",
        "  missing-wrapped.md",
        '  "Wrapped"',
        '[multi-double]: missing-multi-double.md "A title',
        'continued on the next line"',
        "[multi-single]: missing-multi-single.md 'A title",
        "continued on the next line'",
        "[multi-paren]: missing-multi-paren.md (A title",
        "continued on the next line)",
        "[multi",
        "line]: missing-multi-label.md",
        "[balanced]: missing-balanced(1).md",
        "[escaped-parens]: missing-escaped\\(1\\).md",
        "[angle]: <missing file.md>",
        "> [quote]: missing-quote.md",
        "- [list]: missing-list.md",
        "- [list-indent]:",
        "  missing-list-indent.md",
        "[unterminated]: missing-unterminated.md",
        '"unclosed title',
        "",
        "[blank-title]: missing-blank-title.md",
        '"A title',
        "",
        "[after-blank]: missing-after-blank.md",
        'closes here"',
      ].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([
    "docs/a.md: ../../adr/0001-hybrid-orchestrator-runtime.md leaves the package",
    "docs/a.md: c.md is not shipped (docs/c.md)",
    "docs/a.md: missing-double.md is not shipped (docs/missing-double.md)",
    "docs/a.md: missing-single.md is not shipped (docs/missing-single.md)",
    "docs/a.md: missing-paren.md is not shipped (docs/missing-paren.md)",
    "docs/a.md: missing-escaped.md is not shipped (docs/missing-escaped.md)",
    "docs/a.md: missing-wrapped.md is not shipped (docs/missing-wrapped.md)",
    "docs/a.md: missing-multi-double.md is not shipped (docs/missing-multi-double.md)",
    "docs/a.md: missing-multi-single.md is not shipped (docs/missing-multi-single.md)",
    "docs/a.md: missing-multi-paren.md is not shipped (docs/missing-multi-paren.md)",
    "docs/a.md: missing-multi-label.md is not shipped (docs/missing-multi-label.md)",
    "docs/a.md: missing-balanced(1).md is not shipped (docs/missing-balanced(1).md)",
    "docs/a.md: missing-escaped(1).md is not shipped (docs/missing-escaped(1).md)",
    "docs/a.md: missing file.md is not shipped (docs/missing file.md)",
    "docs/a.md: missing-quote.md is not shipped (docs/missing-quote.md)",
    "docs/a.md: missing-list.md is not shipped (docs/missing-list.md)",
    "docs/a.md: missing-list-indent.md is not shipped (docs/missing-list-indent.md)",
    "docs/a.md: missing-unterminated.md is not shipped (docs/missing-unterminated.md)",
    "docs/a.md: missing-blank-title.md is not shipped (docs/missing-blank-title.md)",
    "docs/a.md: missing-after-blank.md is not shipped (docs/missing-after-blank.md)",
  ]);
});

// Requirement: a reference definition to an absolute URL or a shipped path passes.
// Usefulness: verifies the definition reader accepts every valid form, so the
// check does not report a link that the package ships. Each title form and a
// wrapped destination must pass here.
test("the link check passes reference definitions to an absolute URL and a shipped path", () => {
  const shipped = new Set(["docs/a.md", "docs/b.md", "README.md"]);
  const documents = [
    {
      path: "docs/a.md",
      text: [
        '[site]: https://example.com/x.md "Site"',
        "[readme]: <../README.md>",
        "[sibling]: b.md 'Sibling'",
        "[here]: #section",
        "[part]: b.md#part (Part)",
        '[double]: b.md "Double"',
        "[single]: b.md 'Single'",
        "[paren]: b.md (Paren)",
        '[escaped]: b.md "A \\"quoted\\" title"',
        "[wrapped]:",
        "  b.md",
        '  "Wrapped"',
        '[multi-pass]: b.md "A title',
        'continued"',
        "> [quote-pass]: b.md",
        "- [list-pass]: b.md",
        "- [list-wrapped]:",
        "  b.md",
      ].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([]);
});

// Requirement: a fence that opens after a list marker is a fenced code block.
// Usefulness: verifies the reader skips a sample definition inside a fence that
// follows a bullet or ordered list marker, so a shipped sample cannot fail as a
// live definition. The definition after the fences must still fail, so a fence
// that never closes cannot make the check pass.
test("the link check ignores definitions inside a fence after a list marker", () => {
  const shipped = new Set(["docs/a.md"]);
  const documents = [
    {
      path: "docs/a.md",
      text: [
        "- ```md",
        "  [bullet]: ../bullet.md",
        "  ```",
        "1. ```md",
        "   [ordered]: ../ordered.md",
        "   ```",
        "[after]: ../after.md",
      ].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([
    "docs/a.md: ../after.md is not shipped (after.md)",
  ]);
});

// Requirement: indented and fenced code lines are not reference definitions.
// Usefulness: prevents the reader from flagging code samples that look like
// definitions, which are not links. An info-string fence line must not end a block.
test("the link check ignores definitions inside fenced code and four-space indents", () => {
  const shipped = new Set(["docs/a.md"]);
  const documents = [
    {
      path: "docs/a.md",
      text: [
        "```md",
        "```md",
        "[adr]: ../../adr/0001-hybrid-orchestrator-runtime.md",
        "```",
        "    [missing]: ../../missing.md",
        "[wrapped]:",
        "    ../wrapped.md",
        "[blank-label",
        "",
        "line]: ../missing-blank-label.md",
        "~~~",
        "[gone]: ../gone.md",
        "~~~",
      ].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([]);
});
