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

/** Returns true when `target` names `source` in a Supersedes statement or section. */
function hasSupersedesBacklink(target, source) {
  const reference = new RegExp(`ADR ${source}\\b`);
  const section = target.text.split(/^## Supersedes\s*$/m)[1] ?? "";
  if (reference.test(section)) return true;
  return target.text.split("\n").some((line) => /supersede/i.test(line) && reference.test(line));
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
    const adr = byNumber.get(number);
    if (!adr) {
      problems.add(`index entry ${number} links ${entry.path}, which has no ADR file`);
      continue;
    }
    const linkPattern = /\[ADR (\d{4})[^\]]*\]\([^)]+\)/g;
    for (const line of adr.text.split("\n")) {
      if (!/Superseded by/.test(line)) continue;
      for (const match of line.matchAll(linkPattern)) {
        const target = byNumber.get(match[1]);
        if (!target) {
          problems.add(`ADR ${number} is superseded by missing ADR ${match[1]}`);
        } else if (!hasSupersedesBacklink(target, number)) {
          problems.add(`ADR ${target.number} has no Supersedes backlink to ADR ${number}`);
        }
      }
    }
  }

  expect([...problems]).toEqual([]);
});
