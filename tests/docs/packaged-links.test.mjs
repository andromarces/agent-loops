import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

// npm ships these root files even when the `files` allowlist omits them.
const ALWAYS_SHIPPED = ["README.md", "package.json"];

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
  const files = new Set(ALWAYS_SHIPPED);
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

/** Returns the inline link targets of a Markdown text. */
function linkTargets(text) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(text))) targets.push(match[1].replace(/^<|>$/g, ""));
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

// Requirement: no packaged doc links to a path outside the package (issue #1398).
// Usefulness: verifies every relative link resolves to a shipped file, so a
// shipped doc cannot break with a link such as ../../adr/. No other check reads
// the links of the packaged docs against the `files` allowlist.
test("every relative link in a packaged doc resolves to a shipped file", async () => {
  const { files = [] } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const shipped = await shippedFiles(files);
  const docs = [...shipped].filter((path) => path.startsWith("docs/") && path.endsWith(".md"));
  const documents = await Promise.all(
    docs.map(async (path) => ({ path, text: await readFile(join(root, path), "utf8") })),
  );
  const problems = findUnshippedLinks(documents, shipped);
  expect(problems, `Unshipped links in packaged docs:\n${problems.join("\n")}`).toEqual([]);
});

// Requirement: the link check fails on a link that the package does not ship.
// Usefulness: covers the detector itself on a known-bad document, so a broken
// matcher cannot make the real-doc test pass. The passing cases are the forms
// the docs use: an absolute URL, a same-file anchor, and a shipped sibling.
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
  ];
  expect(findUnshippedLinks(documents, shipped)).toEqual([
    "docs/a.md: ../../adr/0001-hybrid-orchestrator-runtime.md leaves the package",
    "docs/a.md: c.md is not shipped (docs/c.md)",
  ]);
});
