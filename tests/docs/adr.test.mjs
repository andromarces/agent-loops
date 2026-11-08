import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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

/** Resolves one Markdown link to its destination ADR file name and displayed ADR number. */
function linkParts(match) {
  const destination = match[2].trim().split("#")[0].split("?")[0];
  const fileName = destination.split("/").pop();
  return {
    fileName,
    fileNumber: /^\d{4}-.+\.md$/.test(fileName) ? fileName.slice(0, 4) : null,
    displayed: match[1].match(/\bADR (\d{4})\b/)?.[1] ?? null,
    index: match.index,
  };
}

/** Collects the supersedes and superseded-by relations that one ADR states. */
function relationsOf(adr) {
  const section = supersedesSectionLines(adr.text);
  const supersedes = [];
  const supersededBy = [];
  adr.text.split("\n").forEach((line, lineIndex) => {
    for (const sentence of sentencesOf(line)) {
      for (const match of sentence.matchAll(ADR_LINK)) {
        const link = linkParts(match);
        if (!link.fileNumber) continue;
        if (SUPERSEDED_BY.test(sentence.slice(0, link.index))) supersededBy.push(link);
        const sectionBullet = section.has(lineIndex) && /^\s*[-*]\s+/.test(line);
        if (SUPERSEDES_STATEMENT.test(statementText(sentence)) || sectionBullet) {
          supersedes.push(link);
        }
      }
    }
  });
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

  const relations = new Map(adrs.map((adr) => [adr.number, relationsOf(adr)]));
  for (const adr of adrs) {
    const { supersedes, supersededBy } = relations.get(adr.number);
    for (const link of [...supersedes, ...supersededBy]) {
      if (!link.fileNumber) {
        problems.add(`ADR ${adr.number} supersede link targets ${link.fileName}, not an ADR file`);
      } else if (!byNumber.has(link.fileNumber)) {
        problems.add(`ADR ${adr.number} supersede link targets missing ADR ${link.fileNumber}`);
      }
      if (link.displayed && link.displayed !== link.fileNumber) {
        problems.add(
          `ADR ${adr.number} link text names ADR ${link.displayed} but links ${link.fileName}`,
        );
      }
    }
    for (const link of supersededBy) {
      if (!link.fileNumber || !byNumber.has(link.fileNumber)) continue;
      const target = relations.get(link.fileNumber);
      if (!target.supersedes.some((backlink) => backlink.fileNumber === adr.number)) {
        problems.add(`ADR ${link.fileNumber} has no Supersedes backlink to ADR ${adr.number}`);
      }
    }
  }

  expect([...problems]).toEqual([]);
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
