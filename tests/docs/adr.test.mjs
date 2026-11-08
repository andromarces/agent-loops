import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const adrDir = fileURLToPath(new URL("../../adr/", import.meta.url));
const ALLOWED_STATUSES = new Set([
  "proposed",
  "accepted",
  "deprecated",
  "superseded",
  "partially-superseded",
]);
const INDEX_ENTRY = /^- (\d{4}) — \[[^\]]+\]\(([^)]+)\) — (\S+) — /;
const ADR_LINK = /\[([^\]]*)\]\(([^)]+)\)/g;
const SUPERSEDED_BY = /\b(?:partially )?superseded by\b/i;
const SUPERSEDES_STATEMENT = /^(?:this adr(?: also)? |it(?: also)? )?(?:partially )?supersedes\b/i;

/** Removes a list marker or bold wrapper before a supersede statement is matched. */
function statementText(sentence) {
  return sentence
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1");
}

/** Returns true when a link claims an ADR through its text or destination. */
function isAdrLink(link) {
  return link.displayed !== null || /^\d{4}-/.test(link.fileName);
}

/** Groups the text into paragraphs and list items with their line ranges. */
function blocksOf(text) {
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  lines.forEach((line, index) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      blocks.push({ start: index, end: index, lines: [line] });
      return;
    }
    if (/^\s*[-*]\s+/.test(line)) flush();
    if (!current) current = { start: index, end: index, lines: [line] };
    else {
      current.end = index;
      current.lines.push(line);
    }
  });
  flush();
  return blocks.map((block) => ({
    start: block.start,
    end: block.end,
    text: block.lines.map((line) => line.trim()).join(" "),
  }));
}

/** Returns the problems of every ADR link in a supersede relation. */
function adrLinkProblems(adr, relations, byPath) {
  const problems = new Set();
  for (const link of [...relations.supersedes, ...relations.supersededBy]) {
    const target = byPath.get(link.path);
    if (!target) {
      problems.add(`ADR ${adr.number} supersede link targets ${link.destination}, not an ADR file`);
    } else if (link.displayed && link.displayed !== target.number) {
      problems.add(
        `ADR ${adr.number} link text names ADR ${link.displayed} but links ${target.name}`,
      );
    }
  }
  return [...problems];
}

/** Reads every ADR file with its number, file name, status, and text. */
async function readAdrs() {
  const names = (await readdir(adrDir)).filter((name) => /^\d{4}-.+\.md$/.test(name));
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(adrDir, name), "utf8");
      const status = text.match(/^## Status\s*\n+\s*(\S+)/m)?.[1];
      return { number: name.slice(0, 4), name, status, text };
    }),
  );
}

/** Returns the line indexes of the `Supersedes` section, bounded by a heading of level 1 or 2. */
function supersedesSectionLines(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^##\s+Supersedes\s*$/i.test(line));
  const indexes = new Set();
  if (start === -1) return indexes;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,2}\s+/.test(lines[index])) break;
    indexes.add(index);
  }
  return indexes;
}

/** Splits a line into sentences so a supersede phrase stays with its own links. */
function sentencesOf(line) {
  return line.split(/(?<=[.!?])\s+/);
}

/**
 * Returns the index where the clause that a leading supersede phrase governs ends.
 * A conjunction that does not introduce a link, or a semicolon, ends that clause.
 * Text inside a link is not a clause boundary.
 */
function supersedeClauseEnd(sentence) {
  const links = [...sentence.matchAll(ADR_LINK)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const breakPattern = /;|[,;]?\s+(?:and|but|while|whereas|although|yet)\s+(\S)/gi;
  for (const match of sentence.matchAll(breakPattern)) {
    if (links.some((link) => match.index >= link.start && match.index < link.end)) continue;
    if (match[1] !== "[") return match.index;
  }
  return sentence.length;
}

/** Resolves one Markdown link against the ADR directory and reads its displayed ADR number. */
function linkParts(match) {
  const destination = match[2].trim().split("#")[0].split("?")[0];
  const path = resolve(adrDir, destination);
  return {
    destination,
    path,
    fileName: basename(path),
    displayed: match[1].match(/\bADR (\d{4})\b/)?.[1] ?? null,
    index: match.index,
  };
}

/** Collects the supersedes and superseded-by relations that one ADR states. */
function relationsOf(adr) {
  const section = supersedesSectionLines(adr.text);
  const supersedes = [];
  const supersededBy = [];
  for (const block of blocksOf(adr.text)) {
    const inSection = section.has(block.start) && section.has(block.end);
    for (const sentence of sentencesOf(block.text)) {
      const clauseEnd = supersedeClauseEnd(sentence);
      for (const match of sentence.matchAll(ADR_LINK)) {
        const link = linkParts(match);
        if (!isAdrLink(link)) continue;
        if (SUPERSEDED_BY.test(sentence.slice(0, link.index))) supersededBy.push(link);
        if (
          inSection ||
          (link.index < clauseEnd && SUPERSEDES_STATEMENT.test(statementText(sentence)))
        ) {
          supersedes.push(link);
        }
      }
    }
  }
  return { supersedes, supersededBy };
}

// Usefulness: checks the ADR index, status values, and two-way supersede links — no test covers these.
test("the ADR index and supersede links follow the ADR rules", async () => {
  const adrs = await readAdrs();
  const byNumber = new Map(adrs.map((adr) => [adr.number, adr]));
  const readme = await readFile(join(adrDir, "README.md"), "utf8");
  const entries = new Map();
  const problems = new Set();

  for (const line of readme.split("\n")) {
    if (!/^- \d{4} — /.test(line)) continue;
    const match = line.match(INDEX_ENTRY);
    if (!match) {
      problems.add(`index entry has no file, status, and summary form: ${line.slice(0, 80)}`);
      continue;
    }
    entries.set(match[1], { path: match[2], status: match[3] });
  }

  for (const adr of adrs) {
    if (!ALLOWED_STATUSES.has(adr.status)) {
      problems.add(`ADR ${adr.number} has status ${JSON.stringify(adr.status)}`);
    }
    const entry = entries.get(adr.number);
    if (!entry) {
      problems.add(`ADR ${adr.number} has no index entry`);
      continue;
    }
    if (entry.path !== adr.name) {
      problems.add(`ADR ${adr.number} index links ${entry.path}, not ${adr.name}`);
    }
    if (entry.status !== adr.status) {
      problems.add(
        `ADR ${adr.number} index status ${JSON.stringify(entry.status)} does not match ${JSON.stringify(adr.status)}`,
      );
    }
  }

  for (const [number, entry] of entries) {
    if (!byNumber.has(number)) {
      problems.add(`index entry ${number} links ${entry.path}, which has no ADR file`);
    }
  }

  const byPath = new Map(adrs.map((adr) => [join(adrDir, adr.name), adr]));
  const relations = new Map(adrs.map((adr) => [adr.number, relationsOf(adr)]));
  for (const adr of adrs) {
    const adrRelations = relations.get(adr.number);
    for (const problem of adrLinkProblems(adr, adrRelations, byPath)) problems.add(problem);
    for (const link of adrRelations.supersededBy) {
      const target = byPath.get(link.path);
      if (!target) continue;
      const targetRelations = relations.get(target.number);
      if (
        !targetRelations.supersedes.some((backlink) => backlink.path === join(adrDir, adr.name))
      ) {
        problems.add(`ADR ${target.number} has no Supersedes backlink to ADR ${adr.number}`);
      }
    }
  }

  expect([...problems]).toEqual([]);
});

// Usefulness: requires an ADR link to name an existing ADR file — a missing or .txt destination must fail.
test("an ADR supersede link must target an existing ADR file", () => {
  const adr = {
    number: "0068",
    name: "0068-example.md",
    text: "## Status\n\nsuperseded\n\nSuperseded by [ADR 0076](0076-no-such-adr.md) and [ADR 0076](0076-notes.txt).\n",
  };
  const problems = adrLinkProblems(
    adr,
    relationsOf(adr),
    new Map([[join(adrDir, "0068-example.md"), { number: "0068", name: "0068-example.md" }]]),
  );
  expect(problems).toHaveLength(2);
});

// Usefulness: joins wrapped status lines before matching, so a supersede phrase still finds its ADR link.
test("a wrapped supersede statement still finds its ADR link", () => {
  const adr = {
    number: "0085",
    name: "0085-example.md",
    text: "## Status\n\nsuperseded\n\nPartially supersedes\n[ADR 0081: Example](0081-example.md).\n",
  };
  const links = relationsOf(adr).supersedes.map((link) => link.fileName);
  expect(links).toEqual(["0081-example.md"]);
});

// Usefulness: a related citation after a new predicate is not governed by the supersede phrase, so it must not count as a backlink (issue #1662).
test("a related citation in a supersede sentence is not a backlink", () => {
  const adr = {
    number: "0100",
    name: "0100-example.md",
    text: "## Status\n\naccepted\n\nPartially supersedes [ADR 0069: Example](0069-example.md) and cites [ADR 0068: Example](0068-example.md) as related background.\n",
  };
  const links = relationsOf(adr).supersedes.map((link) => link.fileName);
  expect(links).toEqual(["0069-example.md"]);
});

// Usefulness: an adverb before a new predicate still ends the governed clause, so the later link is not a backlink (issue #1662).
test("an adverb before a new predicate still ends the supersede clause", () => {
  const adr = {
    number: "0100",
    name: "0100-example.md",
    text: "## Status\n\naccepted\n\nPartially supersedes [ADR 0069: Example](0069-example.md) and also cites [ADR 0068: Example](0068-example.md) as related background.\n",
  };
  const links = relationsOf(adr).supersedes.map((link) => link.fileName);
  expect(links).toEqual(["0069-example.md"]);
});

// Usefulness: treats every ADR link in the Supersedes section as a backlink, in a plain paragraph too.
test("a plain paragraph under Supersedes counts as a backlink", () => {
  const adr = {
    number: "0095",
    name: "0095-example.md",
    text: "## Status\n\naccepted\n\n## Supersedes\n\nThis ADR replaces [ADR 0081: Example](0081-example.md).\n\n## Date\n\n2026-11-08\n",
  };
  const links = relationsOf(adr).supersedes.map((link) => link.fileName);
  expect(links).toEqual(["0081-example.md"]);
});

// Usefulness: resolves links against the ADR directory, so a wrong directory or parent path fails.
test("an ADR link resolves against the ADR directory", () => {
  const adr = {
    number: "0068",
    name: "0068-example.md",
    text: "## Status\n\nsuperseded\n\nSuperseded by [ADR 0076](0076-example.md), [ADR 0076](adr/0076-example.md), and [ADR 0076](../0076-example.md).\n",
  };
  const byPath = new Map([
    [join(adrDir, "0068-example.md"), { number: "0068", name: "0068-example.md" }],
    [join(adrDir, "0076-example.md"), { number: "0076", name: "0076-example.md" }],
  ]);
  const problems = adrLinkProblems(adr, relationsOf(adr), byPath);
  expect(problems).toHaveLength(2);
});

// Usefulness: verifies ADR 0095 supersedes each temporary directory reporting rule and keeps the safety rules (issue #1616).
test("ADR 0095 supersedes the temporary directory reporting rules and keeps the safety rules", async () => {
  const adr95 = await readFile(
    join(adrDir, "0095-report-inherited-tmpdir-names-as-diagnostics-not-open-items.md"),
    "utf8",
  );
  const superseded = [
    ["0076", "0076-leave-out-an-inherited-tmpdir-entry-that-the-settle-re-read-no-longer-holds.md"],
    ["0081", "0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md"],
    ["0082", "0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md"],
    ["0085", "0085-let-the-tmpdir-re-check-read-a-terminal-run.md"],
    ["0093", "0093-report-a-held-inherited-tmpdir-name-apart-from-the-possible-leftovers.md"],
  ];
  for (const [number, name] of superseded) {
    const text = await readFile(join(adrDir, name), "utf8");
    expect(text).toMatch(/## Status\s+superseded/);
    expect(text).toContain("[ADR 0095:");
    expect(adr95).toContain(`[ADR ${number}:`);
  }
  expect(adr95).toMatch(/## Status\s+accepted/);
  expect(adr95).toMatch(/no automatic `open` item/i);
  expect(adr95).toMatch(/ADR 0047|ADR 0068/);
  expect(adr95).toMatch(/detection limits/i);
  const readme = await readFile(join(adrDir, "README.md"), "utf8");
  const adr68 = readme.split("\n").find((line) => line.startsWith("- 0068"));
  expect(adr68).not.toContain("qualified by ADR 0076");
  expect(adr68).toContain("ADR 0095");
});
