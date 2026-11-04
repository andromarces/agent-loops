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

const DEFINITION =
  /^ {0,3}\[([^\]]*)\]:[ \t]*(?:<([^<>]*)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Returns the targets of reference-style link definitions in a Markdown text.
 * A definition allows up to three leading spaces, then `[label]:`, then a bare
 * or angle-bracket destination. Four-space indents and fenced code blocks are
 * not definitions.
 */
function definitionTargets(text) {
  const targets = [];
  let fence;
  for (const line of text.split(/\r?\n/)) {
    const marker = FENCE.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const match = DEFINITION.exec(line);
    if (match) targets.push(match[2] ?? match[3]);
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
// reader cannot let a broken packaged link pass.
test("the link check flags a reference definition that the package does not ship", () => {
  const shipped = new Set(["docs/a.md", "docs/b.md", "README.md"]);
  const documents = [
    {
      path: "docs/a.md",
      text: ["[adr]: ../../adr/0001-hybrid-orchestrator-runtime.md", "[missing]: c.md"].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([
    "docs/a.md: ../../adr/0001-hybrid-orchestrator-runtime.md leaves the package",
    "docs/a.md: c.md is not shipped (docs/c.md)",
  ]);
});

// Requirement: a reference definition to an absolute URL or a shipped path passes.
// Usefulness: verifies the definition reader accepts every valid form, so the
// check does not report a link that the package ships.
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
      ].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([]);
});

// Requirement: indented and fenced code lines are not reference definitions.
// Usefulness: prevents the reader from flagging code samples that look like
// definitions, which are not links.
test("the link check ignores definitions inside fenced code and four-space indents", () => {
  const shipped = new Set(["docs/a.md"]);
  const documents = [
    {
      path: "docs/a.md",
      text: [
        "```md",
        "[adr]: ../../adr/0001-hybrid-orchestrator-runtime.md",
        "```",
        "    [missing]: ../../missing.md",
        "~~~",
        "[gone]: ../gone.md",
        "~~~",
      ].join("\n"),
    },
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([]);
});
