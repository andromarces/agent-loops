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
const LABEL_LINE = /^ {0,3}\[([^\]]*)\]:[ \t]*(.*)$/;

/** A title is a double-quoted, single-quoted, or parenthesized string. */
function isTitle(text) {
  return /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))$/.test(text);
}

/** Returns the destination of a definition part with an optional title. */
function parseDestination(text) {
  const match = /^(?:<([^<>]*)>|(\S+))(?:[ \t]+(.*\S))?[ \t]*$/.exec(text);
  if (!match) return undefined;
  if (match[3] !== undefined && !isTitle(match[3])) return undefined;
  return match[1] ?? match[2];
}

/** Returns the destination on a continuation line after at most three spaces. */
function destinationAt(line) {
  const match = /^ {0,3}(\S.*)$/.exec(line);
  return match ? parseDestination(match[1]) : undefined;
}

/** Returns the title on a continuation line after at most three spaces. */
function titleAt(line) {
  const match = /^ {0,3}(.*?)[ \t]*$/.exec(line);
  return match && isTitle(match[1]) ? match[1] : undefined;
}

/** Returns true when `line` closes the fence opened by `marker`. */
function closesFence(line, marker) {
  const match = FENCE_CLOSE.exec(line);
  return Boolean(match && match[1][0] === marker[0] && match[1].length >= marker.length);
}

/**
 * Returns the targets of reference-style link definitions in a Markdown text.
 * A definition allows up to three leading spaces, then `[label]:`, then a bare
 * or angle-bracket destination. A destination or title may sit on the next
 * line. Four-space indents and fenced code blocks are not definitions.
 */
function definitionTargets(text) {
  const targets = [];
  const lines = text.split(/\r?\n/);
  let fence;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = opening[1];
      continue;
    }
    const label = LABEL_LINE.exec(line);
    if (!label) continue;
    const rest = label[2];
    if (rest !== "") {
      const destination = parseDestination(rest);
      if (destination !== undefined) targets.push(destination);
      continue;
    }
    const destination = destinationAt(lines[index + 1] ?? "");
    if (destination === undefined) continue;
    index += 1;
    if (titleAt(lines[index + 1] ?? "") !== undefined) index += 1;
    targets.push(destination);
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
// reader cannot let a broken packaged link pass. Title forms and wrapped
// destinations must fail here when the reader breaks.
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
      ].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([]);
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
        "~~~",
        "[gone]: ../gone.md",
        "~~~",
      ].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([]);
});
