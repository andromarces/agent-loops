import { expect, test } from "vite-plus/test";
import {
  hasClosingBlockAttempt,
  acceptanceFailure,
  isAcceptedReview,
  parseReportBlock,
  parseVerdict,
} from "../../src/lib/report.mjs";

const REPORT = "Conclusion: done\nWhy: tests pass\nBlockers: none";

// Usefulness: verifies parseReportBlock extracts the required labels and
// defaults the optional notes and deferred labels to null when absent, so a
// response in the pre-#214 format stays parseable (issue #214).
test("parseReportBlock extracts the closing block and defaults optional labels", () => {
  expect(parseReportBlock(REPORT)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies the optional Notes and Deferred labels reach the parsed
// report, so non-blocking findings and out-of-scope items survive into the
// envelope instead of being dropped (issue #214).
test("parseReportBlock extracts the optional Notes and Deferred labels", () => {
  const response = `${REPORT}\nNotes: tidy the helper later\nDeferred: migrate the legacy path`;
  expect(parseReportBlock(response)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: "tidy the helper later",
    deferred: "migrate the legacy path",
  });
});

// Usefulness: verifies a present-but-empty optional label maps to null rather
// than a misleading empty string.
test("parseReportBlock maps an empty optional label to null", () => {
  expect(parseReportBlock(`${REPORT}\nChecks:\nNotes:\nDeferred:`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies the optional Checks label reaches the parsed report,
// while an absent label stays null and never makes the block unparseable
// (issue #217).
test("parseReportBlock extracts the optional Checks label", () => {
  expect(parseReportBlock(`${REPORT}\nChecks: npm test, npm run lint`)).toMatchObject({
    checks: "npm test, npm run lint",
  });
  expect(parseReportBlock(REPORT)).toMatchObject({ checks: null });
});

// Usefulness: verifies a list that directly follows a label with an empty value line is
// that label's value, joined into one line with "; " and the markers stripped, so a worker
// that writes bullets under `Notes:` or `Why:` still yields a report (issue #846).
test("parseReportBlock joins a list under an empty label into that label's value", () => {
  expect(parseReportBlock(`${REPORT}\nNotes:\n- item one\n- item two`)).toMatchObject({
    notes: "item one; item two",
  });
  expect(parseReportBlock(`${REPORT}\nNotes: none\nDeferred:\n- item one`)).toMatchObject({
    notes: "none",
    deferred: "item one",
  });
  expect(
    parseReportBlock(
      "Conclusion: done\nWhy:\n- **Tests:** pass\n- **Lint:** clean\nBlockers: none",
    ),
  ).toMatchObject({ why: "**Tests:** pass; **Lint:** clean", blockers: "none" });
});

// Usefulness: verifies the list shapes outside the #846 rule still fail closed: a list
// separated from its empty label, a list that follows a non-list line under the label, a
// list that a later repeat of the label shadows, a list after an empty Verdict line, and a
// list that resumes after a non-list line.
test("parseReportBlock returns null for a list that is not directly under an empty label", () => {
  expect(parseReportBlock(`${REPORT}\nNotes:\n\n- item one`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nNotes:\nsome prose\n- item one`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nNotes:\n- item one\nNotes: later`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nVerdict:\n- accept`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nNotes:\n- item one\nprose\n- item two`)).toBeNull();
});

// Usefulness: verifies one level of two-space indented `- ` sub-items under a folded item joins
// into that item with ", ", so a worker that nests a sub-list under a report list still yields a
// report instead of null (issue #870).
test("parseReportBlock joins one level of indented sub-items into their parent item", () => {
  expect(
    parseReportBlock(
      "Conclusion: done\nWhy:\n- **Config.** a\n- **Unverified.**\n  - **Overrides:** b\n  - **Version:** c\nBlockers: none",
    ),
  ).toMatchObject({
    why: "**Config.** a; **Unverified.**, **Overrides:** b, **Version:** c",
    blockers: "none",
  });
  expect(parseReportBlock(`${REPORT}\nNotes:\n- a\n  - b`)).toMatchObject({ notes: "a, b" });
});

// Usefulness: verifies the nesting shapes outside the #870 rule still fail closed: a sub-item
// with no parent item, a second nesting level, a sub-item with another indent width or marker, a
// sub-item after a blank line, and a sub-item under a label that already holds a value.
test("parseReportBlock returns null for a sub-list shape outside one nested level", () => {
  for (const list of [
    "  - a",
    "- a\n    - b",
    "- a\n  - b\n    - c",
    "- a\n   - b",
    "- a\n\t- b",
    "- a\n  * b",
    "- a\n  -b",
    "- a\n  1. b",
    "- a\n\n  - b",
  ]) {
    expect(parseReportBlock(`${REPORT}\nNotes:\n${list}`)).toBeNull();
  }
  expect(parseReportBlock(`${REPORT}\nNotes: none\n  - a`)).toBeNull();
});

// Usefulness: verifies an ordered list (`N. ` at column 0) directly under a label folds like a
// dash list, and that its sub-items fold at the column where the item text starts, so a worker that
// mirrors an ordered list from its parent prompt still yields a report (issue #915).
test("parseReportBlock folds an ordered list and its aligned sub-items under a label", () => {
  expect(
    parseReportBlock(
      "Conclusion: done\nWhy:\n1. **No lint config.** a\n2. **Stale config.** b\nBlockers: none",
    ),
  ).toMatchObject({ why: "**No lint config.** a; **Stale config.** b", blockers: "none" });
  expect(
    parseReportBlock(
      "Conclusion: done\nWhy:\n1. **Config-only push:** a\n2. **Ambient config:** b\n   - c\n   - d\nBlockers: none",
    ),
  ).toMatchObject({ why: "**Config-only push:** a; **Ambient config:** b, c, d" });
  expect(parseReportBlock(`${REPORT}\nNotes:\n10. a\n    - b`)).toMatchObject({ notes: "a, b" });
  expect(parseReportBlock(`${REPORT}\nNotes: a\n1. b`)).toMatchObject({ notes: "a; b" });
});

// Usefulness: verifies the ordered and bold-heading shapes outside the #915 rule still fail closed
// (a sub-item at the wrong indent, a `)` marker, a second space after the marker, an ordered list
// separated from its label, and a bold heading line with a dash list and no label), so `raw`
// carries the text instead of the parser dropping it.
test("parseReportBlock returns null for an ordered or heading-list shape outside the fold", () => {
  for (const list of ["\n1. a\n  - b", "\n1) a", "\n1.  a", "\n\n1. a"]) {
    expect(parseReportBlock(`${REPORT}\nNotes:${list}`)).toBeNull();
  }
  expect(
    parseReportBlock(
      "Conclusion: done\n\n**1 and 2: allowlist.**\n- Both phases parse.\n\n**3: failed kill.**\n- After a timeout.\n\nBlockers: none.",
    ),
  ).toBeNull();
});

// Usefulness: verifies a non-list line after an empty optional label, for
// example a closing sentence or a lone code fence, does not make the block
// unparseable; only a list that would be dropped is flagged (issue #229).
test("parseReportBlock keeps a block whose empty optional label only a non-list line follows", () => {
  expect(parseReportBlock(`${REPORT}\nDeferred:\nLet me know if the fix looks right.`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
  expect(parseReportBlock(`${REPORT}\nDeferred:\n\`\`\``)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies an empty optional label directly followed by the next
// label is not mistaken for dropped text, so the block still parses and the
// other labels survive (issue #229). The reviewer's Verdict line is a label
// boundary too.
test("parseReportBlock keeps an empty optional label that a label follows", () => {
  expect(parseReportBlock(`${REPORT}\nNotes:\nDeferred: migrate the legacy path`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: "migrate the legacy path",
  });
  expect(parseReportBlock(`${REPORT}\nNotes:\nDeferred:\nVerdict: accept`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies a label wrapped in markdown emphasis is not silently
// dropped; the whole block is unparseable, so `raw` carries its value (issue
// #243).
test("parseReportBlock returns null when a label is decorated with emphasis", () => {
  expect(
    parseReportBlock(
      `${REPORT}\nNotes: tidy the helper later\n**Deferred:** migrate the legacy path`,
    ),
  ).toBeNull();
});

// Usefulness: verifies the common markdown label decorations — emphasis closed
// before or after the colon, a heading, a blockquote, a code span, an ordered
// list marker, and a space before the colon — all make the block unparseable,
// so no decorated label value is dropped silently (issue #243).
test("parseReportBlock returns null for common decorated label forms", () => {
  const forms = [
    "**Deferred**: migrate the legacy path",
    "*Deferred:* migrate the legacy path",
    "_Deferred:_ migrate the legacy path",
    "### Deferred: migrate the legacy path",
    "> Deferred: migrate the legacy path",
    "`Deferred:` migrate the legacy path",
    "1. Deferred: migrate the legacy path",
    "Deferred : migrate the legacy path",
  ];
  for (const line of forms) {
    expect(parseReportBlock(`${REPORT}\n${line}`), line).toBeNull();
  }
});

// Usefulness: verifies an indented label does not have its value dropped
// silently; the whole block is unparseable, so `raw` carries the text (issue
// #243).
test("parseReportBlock returns null when a label is indented", () => {
  expect(
    parseReportBlock(`${REPORT}\nNotes: tidy\n  Deferred: migrate the legacy path`),
  ).toBeNull();
});

// Usefulness: verifies a decorated duplicate of a label is not dropped behind
// the plain occurrence the parser reads; the whole block is unparseable (issue
// #243).
test("parseReportBlock returns null when a decorated label shadows a plain one", () => {
  expect(parseReportBlock(`${REPORT}\n**Blockers:** the real blocker`)).toBeNull();
});

// Usefulness: verifies every list shape other than a column-0 `- ` list under an empty label
// stays unparseable, so a spaceless bullet, a `*` or `+` bullet, an ordered item, and an
// indented bullet never fold into a label value (issues #243 and #846).
test("parseReportBlock returns null for a non-`- ` list under an empty label", () => {
  for (const list of [
    "-a\n-b",
    "- a\n-b",
    "*item",
    "* item",
    "+item",
    "+ item",
    "1.item",
    "1.  item",
    "2) item",
    "  - item",
    "*file*.mjs",
    "-\titem",
    "- item",
    "- item",
    "-  item",
    "- a\n-\titem",
  ]) {
    expect(parseReportBlock(`${REPORT}\nDeferred:\n${list}`)).toBeNull();
    expect(parseReportBlock(`${REPORT}\nChecks:\n${list}`)).toBeNull();
  }
});

// Usefulness: verifies a list that a blank line separates from its label, and one under an
// indented or decorated label, stays unparseable, while a `- ` list under an empty required
// label folds (issue #846).
test("parseReportBlock returns null for a list under a hidden label", () => {
  expect(parseReportBlock(`${REPORT}\nNotes: none\n\n- item`)).toBeNull();
  expect(parseReportBlock("Conclusion: done\nWhy: ok\nBlockers:\n- item")).toMatchObject({
    blockers: "item",
  });
  expect(parseReportBlock(`${REPORT}\n  Notes:\n- item`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\n**Notes:**\n- item`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nNotes:\n- item\nNotes:\n- other`)).toBeNull();
});

// Usefulness: verifies a `- ` list that directly follows a label that already holds a value folds
// into that value, joined to it and between items with "; ", so the worker shape of issue #879
// (`Why:` text then bold-label bullets) keeps its parsed fields instead of blanking the report.
test("parseReportBlock folds a list that directly follows a label value into that value", () => {
  expect(
    parseReportBlock(
      "Conclusion: done\nWhy: I found three stale claims and updated each one.\n- **Prompt:** a\n- **Reference doc:** b\nBlockers: none",
    ),
  ).toMatchObject({
    why: "I found three stale claims and updated each one.; **Prompt:** a; **Reference doc:** b",
    blockers: "none",
  });
  expect(parseReportBlock(`${REPORT}\nNotes: two items\n- a\n  - b\n- c`)).toMatchObject({
    notes: "two items; a, b; c",
  });
});

// Usefulness: verifies a label value that itself ends with a colon still counts as a value, so the
// list joins it with "; " instead of being read as an empty label's list (issue #879).
test("parseReportBlock keeps a label value that ends with a colon when a list follows", () => {
  expect(
    parseReportBlock("Conclusion: done\nWhy: Details:\n- first\n- second\nBlockers: none"),
  ).toMatchObject({ why: "Details:; first; second" });
  expect(parseReportBlock(`${REPORT}\nNotes: a: b:\n- c`)).toMatchObject({ notes: "a: b:; c" });
});

// Usefulness: verifies a folded list under the required Blockers label never reads as `none`, so a
// worker that lists a blocker under `Blockers: none` is not reported clear (issue #879).
test("parseReportBlock keeps a list under Blockers visible in the blockers value", () => {
  const report = parseReportBlock("Conclusion: done\nWhy: ok\nBlockers: none\n- real blocker");
  expect(report.blockers).toBe("none; real blocker");
});

// Usefulness: verifies the fold under a label value stays inside the delimiter rule: a list that
// prose or a blank line separates, a non-`- ` list, a sub-item with no parent item, a list that a
// later repeat of the label shadows, and a list after the reviewer Verdict line still fail closed.
test("parseReportBlock returns null for a list after a label value outside the fold rule", () => {
  for (const tail of [
    "Notes: a\nprose\n- b",
    "Notes: a\n-b",
    "Notes: a\n* b",
    "Notes: a\n1) b",
    "Notes: a\n  - b",
    "Notes: a\n- b\nNotes: later",
    "Verdict: accept\n- b",
  ]) {
    expect(parseReportBlock(`${REPORT}\n${tail}`), tail).toBeNull();
  }
});

// Usefulness: verifies a non-label line that begins with a word and a colon is
// not mistaken for a decorated label, so the wider #243 rule does not reject
// ordinary prose below an empty optional label.
test("parseReportBlock keeps a non-label line that begins with a word and a colon", () => {
  expect(parseReportBlock(`${REPORT}\nDeferred:\nNote: this is not a report label`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies a decorated Verdict line leaves the report parseable; a
// malformed verdict already maps to `unknown`, so it never carries report text
// and must not make the report unparseable (issue #243).
test("parseReportBlock keeps the report when only the Verdict label is decorated", () => {
  expect(parseReportBlock(`${REPORT}\n**Verdict:** accept`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies a non-`- ` list under a label that already holds a value is not
// dropped silently; the whole block is unparseable, so `raw` carries the list.
// This covers the required `Blockers` label, which the next turn needs, and the
// optional `Notes` and `Deferred` labels (issue #240).
test("parseReportBlock returns null when a value-bearing label has a following list", () => {
  expect(parseReportBlock(`${REPORT}\nBlockers: see below\n-real blocker`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nNotes: two items\n* a\n* b`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nDeferred: two items\n1) a`)).toBeNull();
});

// Usefulness: verifies the list is flagged even when the next label follows it,
// so a dropped list cannot hide behind an unrelated label (issue #240).
test("parseReportBlock returns null when a list sits between two labels", () => {
  expect(parseReportBlock(`${REPORT}\nNotes: two items\n* a\nDeferred: later`)).toBeNull();
});

// Usefulness: verifies a non-list line after a value-bearing label, for example
// a closing sentence, still parses, so the wider #240 rule does not reject every
// block with trailing prose.
test("parseReportBlock keeps a block whose value-bearing label only a non-list line follows", () => {
  expect(parseReportBlock(`${REPORT}\nNotes: tidy later\nLet me know if that helps.`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: "tidy later",
    deferred: null,
  });
});

// Usefulness: verifies the rule applies to every label, not only the optional
// ones: a `- ` list under `Conclusion` or `Why` folds into the value, and any other list
// shape there is surfaced instead of dropped (issues #240 and #879). The docs and the prompt
// state the rule for any label.
test("parseReportBlock folds or rejects a list that follows Conclusion or Why", () => {
  expect(
    parseReportBlock("Conclusion: done\n- next step\nWhy: tests pass\nBlockers: none"),
  ).toMatchObject({ conclusion: "done; next step", why: "tests pass" });
  expect(
    parseReportBlock("Conclusion: done\nWhy: tests pass\n- test a\nBlockers: none"),
  ).toMatchObject({ why: "tests pass; test a" });
  expect(
    parseReportBlock("Conclusion: done\nWhy: tests pass\n* test a\nBlockers: none"),
  ).toBeNull();
});

// Usefulness: verifies a trailing list that no parsed label owns still makes the
// block unparseable, so a block does not report success while dropping the list
// (issue #240).
test("parseReportBlock returns null when a trailing list follows the last label", () => {
  expect(parseReportBlock(`${REPORT}\nNext steps:\n- run x`)).toBeNull();
});

// Usefulness: verifies a markdown thematic break is not mistaken for a list, so
// a report that ends with a horizontal rule still parses (issue #240).
test("parseReportBlock keeps a block whose label is followed by a thematic break", () => {
  for (const rule of ["* * *", "- - -", "---"]) {
    expect(parseReportBlock(`${REPORT}\nNotes: tidy later\n${rule}`), rule).toEqual({
      conclusion: "done",
      why: "tests pass",
      blockers: "none",
      checks: null,
      notes: "tidy later",
      deferred: null,
    });
  }
});

// Usefulness: verifies a closing sentence that opens like a list item — a
// decimal (`1.5x`), a version (`2.0`), or an arrow (`->`) — is not mistaken for
// a dropped list, so the wider #249 scan does not blank a report whose reviewer
// sentence follows the Verdict line (issue #256).
test("parseReportBlock keeps a block whose closing sentence resembles a list", () => {
  for (const line of ["1.5x faster overall.", "2.0 ships", "-> see above"]) {
    expect(parseReportBlock(`${REPORT}\nVerdict: accept\n${line}`), line).toEqual({
      conclusion: "done",
      why: "tests pass",
      blockers: "none",
      checks: null,
      notes: null,
      deferred: null,
    });
  }
});

// Usefulness: verifies a closing sentence that opens with an emphasis run is
// not mistaken for a dropped bullet, so the wider #249 scan does not blank a
// report whose reviewer sentence follows the Verdict line (issue #259). The run
// closes on a `*` that whitespace, end of line, or a punctuation-only token
// follows, so `*Note*: x`, `*emph*.`, and `*emph*, and more` count as prose too
// (issue #267). A spaceless bullet (`*item`) still registers, so the #243
// behavior survives in the companion test.
test("parseReportBlock keeps a block whose closing sentence opens with emphasis", () => {
  for (const line of [
    "*emphasis* note",
    "*emphasis*",
    "*two words* here",
    "*Note*: x",
    "*emph*.",
    "*emph*, and more",
    "*emph*; then",
  ]) {
    expect(parseReportBlock(`${REPORT}\nVerdict: accept\n${line}`), line).toEqual({
      conclusion: "done",
      why: "tests pass",
      blockers: "none",
      checks: null,
      notes: null,
      deferred: null,
    });
  }
});

// Usefulness: verifies a spaceless bullet is still a dropped list when the line
// holds a later ` * `, so the emphasis exclusion cannot hide the item, which
// drops it while the block still parses and `raw` stays silent (issue #259). A
// `*` closes an emphasis run only when a non-space precedes it, as CommonMark
// requires.
test("parseReportBlock returns null when a spaceless bullet holds a later spaced star", () => {
  for (const line of ["*a * b", "*item with 2 * 3 math", "*item one * item two"]) {
    expect(parseReportBlock(`${REPORT}\nNotes: x\n${line}`), line).toBeNull();
  }
});

// Usefulness: verifies a spaceless bullet whose later `*` is a wildcard or
// multiplication and a non-letter precedes it is flagged as a dropped list, not
// read as an emphasis run, so the item is not dropped with no `raw` signal
// (issue #264). The block is unparseable, so `raw` carries the item.
test("parseReportBlock returns null when a spaceless bullet holds a later non-letter star", () => {
  for (const line of ["*glob src/*.mjs", "*use 2* 3"]) {
    expect(parseReportBlock(`${REPORT}\nNotes: x\n${line}`), line).toBeNull();
  }
});

// Usefulness: verifies the narrowed rule treats an emphasis run closed after a
// non-letter as a dropped list, the stated cost of closing the silent-drop gap
// (issue #264). Blanking the report is the safe direction: the text survives in
// `raw`, whereas the silent-drop shape loses it. A letter-closed run stays prose
// in the companion test.
test("parseReportBlock returns null when an emphasis run closes after a non-letter", () => {
  for (const line of ["*see step 1* done", "*wow!* nice", "*two words,* rest"]) {
    expect(parseReportBlock(`${REPORT}\nNotes: x\n${line}`), line).toBeNull();
  }
});

// Usefulness: verifies a spaceless bullet whose later `*` a letter precedes is
// flagged as a dropped list when the close is glued to a following token that
// carries a letter, for example a glob (`*file*.mjs`, `*glob src/a*.mjs`), so
// the item is not read as an emphasis run and dropped with no `raw` signal
// (issue #267). A real emphasis run closed before a punctuation-only token
// (`*Note*: x`, `*emph*.`) stays prose in the companion test.
test("parseReportBlock returns null when a spaceless bullet closes before a joined word", () => {
  for (const line of ["*file*.mjs", "*glob src/a*.mjs"]) {
    expect(parseReportBlock(`${REPORT}\nNotes: x\n${line}`), line).toBeNull();
  }
});

// Usefulness: verifies the narrowed rule treats an emphasis run glued to a
// following token that carries a letter or an ASCII digit as a dropped list,
// the stated cost of closing the silent-drop gap (issue #267). The cost covers a
// glued word (`*self*-hosted`), a possessive (`*Claude*'s review`), an unspaced
// em dash (`*emph*—then more`), a slash (`*a*/b`), a colon with no following
// space (`*Note*:x`), and a numeric continuation (`*emph*.2`). Blanking the
// report is the safe direction: the text survives in `raw`, whereas the
// silent-drop shape loses it. A run closed before a space, end of line, or a
// punctuation-only token stays prose in the companion test.
// Usefulness: `*emph*é` pins that the letter check after the close is `\p{L}`
// and not ASCII-only. Two of the other nine shapes carry a non-ASCII apostrophe
// or em dash, and none carries a non-ASCII letter or digit, so none of them
// reaches the check where script matters (issue #291).
test("parseReportBlock returns null when an emphasis run is glued to a following word", () => {
  for (const line of [
    "*self*-hosted",
    "*Note*head",
    "*emph*text",
    "*Claude*'s review",
    "*Claude*’s review",
    "*emph*—then more",
    "*a*/b",
    "*Note*:x",
    "*emph*.2",
    "*emph*é",
  ]) {
    expect(parseReportBlock(`${REPORT}\nNotes: x\n${line}`), line).toBeNull();
  }
});

// Usefulness: pins the accepted decision for #275 and its corrected ceiling. A
// spaceless `*` bullet whose closing `*` a letter precedes, where the character
// right after the close is not a word character or `*`, and where nothing glued
// from that character on is a letter or an ASCII digit, is the same bytes as a
// real emphasis run, so the line stays prose: the report still parses and the
// bullet is dropped with no `raw` signal. Every matching line in the block drops
// this way, not only the first, so a block can lose three lines under one label
// and still parse. The gap is accepted, and the acceptance is stated in the
// `known-limit` note in src/lib/report.mjs, in docs/orchestrator-instructions.md,
// and in docs/reference/role.md. This test pins the accepted cost, so a future narrowing
// changes it on purpose.
// Usefulness: `*glob é*` and `*emph*٢` pin the two checks that the four ASCII
// shapes above never reach. The letter before the close is `\p{L}`, so a
// non-ASCII letter exempts the line, and a digit is `\d`, which is ASCII-only,
// so a non-ASCII digit exempts it too. Neither holds for the ASCII shapes, which
// is what let the prose drift (issues #290 and #291).
test("parseReportBlock leaves the accepted residual letter-star bullet as prose", () => {
  for (const line of [
    "*file*",
    "*glob src/a*",
    "*use a* b",
    "*glob src/a*, b",
    "*glob é*",
    "*emph*٢",
  ]) {
    expect(parseReportBlock(`${REPORT}\nNotes:\n${line}`), line).toEqual({
      conclusion: "done",
      why: "tests pass",
      blockers: "none",
      checks: null,
      notes: null,
      deferred: null,
    });
  }
  // The ceiling is every matching line, under any label.
  expect(
    parseReportBlock(`${REPORT}\nNotes:\n*file*\n*glob src/a*\n*use a* b\nDeferred:\n*left*`),
  ).toMatchObject({ notes: null, deferred: null });
  expect(
    parseReportBlock(`Conclusion: done\nWhy: tests pass\nBlockers: none\n*file*`),
  ).toMatchObject({
    blockers: "none",
  });
});

// Usefulness: verifies a closing sentence that opens with an ordered marker
// followed by another list marker (`1.-x`, `1.*x`, `1.+x`) is not mistaken for a
// dropped list, so the wider #249 scan does not blank the report (issue #259).
test("parseReportBlock keeps a block whose closing sentence opens with an ordered marker", () => {
  for (const line of ["1.-x", "1.*x", "1.+x"]) {
    expect(parseReportBlock(`${REPORT}\nVerdict: accept\n${line}`), line).toEqual({
      conclusion: "done",
      why: "tests pass",
      blockers: "none",
      checks: null,
      notes: null,
      deferred: null,
    });
  }
});

// Usefulness: verifies a list under an earlier, shadowed occurrence of a label
// is not dropped when a later occurrence wins the label value; the whole block
// is unparseable, so the dispatch layer surfaces the list through `raw` (issue
// #249).
test("parseReportBlock returns null when a list sits under a shadowed earlier label", () => {
  expect(
    parseReportBlock(`${REPORT}\nNotes: first pass\n- dropped item\nNotes: second pass`),
  ).toBeNull();
});

// Usefulness: verifies a list after the reviewer Verdict line makes the block
// unparseable, so the list surfaces through `raw` instead of being dropped
// (issue #249, folded from the #240 review).
test("parseReportBlock returns null when a list follows the Verdict line", () => {
  expect(parseReportBlock(`${REPORT}\nVerdict: accept\n- dropped item`)).toBeNull();
});

// Usefulness: verifies the wider #249 list scan does not change which value a
// repeated label yields: the last occurrence still wins when no list appears.
test("parseReportBlock keeps last-occurrence-wins for a repeated label without a list", () => {
  expect(parseReportBlock(`${REPORT}\nNotes: first pass\nNotes: second pass`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: "second pass",
    deferred: null,
  });
});

// Usefulness: verifies only the last Conclusion block counts, so a verdict or
// report in earlier prose never leaks into the parsed result.
test("parseReportBlock parses only after the last Conclusion line", () => {
  const response = `Conclusion: earlier\nWhy: old\nBlockers: old\nprose\n${REPORT}`;
  expect(parseReportBlock(response)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies a missing required label inside the closing block yields
// null, while the optional labels stay optional.
test("parseReportBlock returns null when a required label is missing", () => {
  expect(parseReportBlock("Conclusion: done\nWhy: tests pass")).toBeNull();
  expect(parseReportBlock("Conclusion: done\nBlockers: none")).toBeNull();
});

// Usefulness: verifies a response without a Conclusion line yields null.
test("parseReportBlock returns null without a Conclusion line", () => {
  expect(parseReportBlock("Why: tests pass\nBlockers: none")).toBeNull();
});

// Usefulness: verifies label matching is case-insensitive, including the new
// optional labels.
test("parseReportBlock matches labels case-insensitively", () => {
  expect(
    parseReportBlock(
      "conclusion: done\nWHY: tests pass\nblockers: none\nchecks: npm test\nnotes: later\ndeferred: out",
    ),
  ).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: "npm test",
    notes: "later",
    deferred: "out",
  });
});

// Usefulness: verifies the verdict word parses case-insensitively so `Accept`
// from a real model does not collapse to `unknown`.
test("parseVerdict parses the verdict word case-insensitively", () => {
  expect(parseVerdict(`${REPORT}\nVerdict: accept`)).toBe("accept");
  expect(parseVerdict(`${REPORT}\nVerdict: Accept`)).toBe("accept");
  expect(parseVerdict(`${REPORT}\nVerdict: reject`)).toBe("reject");
});

// Usefulness: verifies a separated clause after the verdict word (the
// live-model shape that parsed as unknown) still yields that word.
test("parseVerdict keeps a verdict followed by a separated clause", () => {
  expect(parseVerdict(`${REPORT}\nVerdict: reject — the reviewed state does not pass.`)).toBe(
    "reject",
  );
});

// Usefulness: verifies a verdict word closed by the sentence period the
// prompt's own example invites still parses to that word.
test("parseVerdict strips a trailing sentence period", () => {
  expect(parseVerdict(`${REPORT}\nVerdict: accept.`)).toBe("accept");
  expect(parseVerdict(`${REPORT}\nVerdict: reject.`)).toBe("reject");
});

// Usefulness: verifies a line that names both verdicts does not collapse to the
// first word, with or without the punctuation separator.
test("parseVerdict yields unknown when both verdicts are named", () => {
  for (const line of ["accept or reject", "accept, reject", "accept — or reject"]) {
    expect(parseVerdict(`${REPORT}\nVerdict: ${line}`), line).toBe("unknown");
  }
});

// Usefulness: verifies a verdict outside the closing block never counts — only
// a `Verdict:` line after the last `Conclusion:` line can produce a verdict.
test("parseVerdict ignores a Verdict line outside the closing block", () => {
  expect(parseVerdict(`Verdict: accept\n${REPORT}\nfinal note after the block`)).toBe("unknown");
});

// Usefulness: verifies a response without a Verdict line yields unknown.
test("parseVerdict yields unknown without a Verdict line", () => {
  expect(parseVerdict("looks fine, but no verdict line here")).toBe("unknown");
});

const MALFORMED_SHAPES = [
  "1.Conclusion: c\n2.Why: w\n3.Blockers: none",
  "1) Conclusion: c\nWhy: w\nBlockers: none",
  "1)Conclusion: c\nWhy: w\nBlockers: none",
  "-Conclusion: c\n-Why: w\n-Blockers: none",
  "- Conclusion: c\n- Why: w\n- Blockers: none",
  "*Conclusion*: c\nWhy: w\nBlockers: none",
  "**Conclusion**: c\n**Why**: w\n**Blockers**: none",
  "### Conclusion: c\nWhy: w\nBlockers: none",
  "###Conclusion: c\nWhy: w\nBlockers: none",
  "> Conclusion: c\n> Why: w\n> Blockers: none",
  ">Conclusion: c\nWhy: w\nBlockers: none",
  "  Conclusion: c\n  Why: w\n  Blockers: none",
  "Conclusion: c\nWhy: w\nBlockers:\n- one\n- two",
  "Conclusion: c\nWhy: w\nBlockers: none\n1.Deferred: x",
  "Conclusion: c\nWhy: w\nBlockers: none\n**Verdict**: reject",
  "Conclusion: c\nWhy: w\nBlockers: none\n1.Verdict: reject",
  "Conclusion: c\nWhy: w",
  "Verdict: reject",
  "  - 1.Verdict: accept",
  "a.Conclusion: c\nb.Why: w\nc.Blockers: none",
  "a) Verdict: accept",
  "(a) Conclusion: c",
  "Step one. Conclusion: c",
  "see Verdict: reject",
  "x**Why**: w",
  "text conclusion : c",
  REPORT,
  `${REPORT}\nVerdict: accept`,
];

// Usefulness: ties the closing-block attempt rule to the parser (issue #449): whenever the parser sees a closing block or treats a label line as part of one, the response counts as an attempt, so a malformed final report is never replaced by an earlier one.
test("hasClosingBlockAttempt holds for every malformed or parseable closing block shape", () => {
  for (const shape of MALFORMED_SHAPES) {
    expect(hasClosingBlockAttempt(shape), shape).toBe(true);
  }
});

// Usefulness: keeps late prose, which is no report, outside the attempt rule so the earlier block still recovers (issue #449).
test("hasClosingBlockAttempt is false for prose and lists with no label", () => {
  for (const prose of [
    "Noted the late event.",
    "- one\n- two",
    "1. first\n2. second",
    "Conclusions follow later",
    "The conclusion is none yet.",
    "Notes about the verdict",
  ]) {
    expect(hasClosingBlockAttempt(prose), prose).toBe(false);
  }
});

// Usefulness: verifies a spaceless bullet under an empty Checks line never supplies the Checks
// text that an accept needs, while a `- ` item does (issues #218 and #846).
test("isAcceptedReview never accepts from a folded spaceless bullet", () => {
  const review = (list) => `${REPORT}\nVerdict: accept\nChecks:\n${list}`;
  expect(isAcceptedReview(review("-item"))).toBe(false);
  expect(isAcceptedReview(review("*item"))).toBe(false);
  expect(isAcceptedReview(review("1.item"))).toBe(false);
  expect(isAcceptedReview(review("-\titem"))).toBe(false);
  expect(isAcceptedReview(review("- item"))).toBe(false);
  expect(isAcceptedReview(review("- npm test passed"))).toBe(true);
});

// Usefulness: pins the one shared acceptance rule that the accept gate reads to pick its refusal
// message, so the verdict and Checks checks cannot drift from isAcceptedReview (issue #814).
test("acceptanceFailure names the failing acceptance check or null", () => {
  expect(acceptanceFailure(`${REPORT}\nVerdict: reject\nChecks: npm test passed`)).toBe("verdict");
  expect(acceptanceFailure(`${REPORT}\nVerdict: accept\nChecks:`)).toBe("checks");
  expect(acceptanceFailure(`${REPORT}\nVerdict: accept\nChecks: npm test passed`)).toBeNull();
});

// Usefulness: verifies a prose heading line and the `- ` list directly under it, set apart from the
// preceding label by a blank line, fold into that label's value, so a worker that writes a
// sub-heading with a list between two labels still yields a report instead of null (issue #898).
test("parseReportBlock folds a prose heading and its list into the preceding label", () => {
  expect(
    parseReportBlock(
      "Conclusion: done\nWhy: tests pass\n\nDesign settled in ADR 0031:\n- **Non-limit failure:** a\n- **Pagination:** b\n\nBlockers: none",
    ),
  ).toEqual({
    conclusion: "done",
    why: "tests pass; Design settled in ADR 0031: **Non-limit failure:** a; **Pagination:** b",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });
  expect(parseReportBlock(`${REPORT}\nNotes:\n\nHeading\n- a\n  - b`)).toMatchObject({
    notes: "Heading: a, b",
  });
});

// Usefulness: verifies the shapes that stay unparseable next to the #898 rule: no blank line before
// the prose, no prose heading, prose after another prose line, prose after the `Verdict:` line, and
// a repeat of the label that took the heading list, so no list drops without a `raw` signal.
test("parseReportBlock returns null for a prose and list shape outside the heading rule", () => {
  for (const tail of [
    "Notes: x\nHeading:\n- a",
    "Notes: x\n\n\n- a",
    "Notes: x\n\nprose one\nHeading:\n- a",
    "Verdict: accept\n\nHeading:\n- a",
    "Notes: x\n\nHeading:\n- a\n\nNotes: later",
    "Notes: x\n\nHeading:\n\n- a",
    "Notes: x\n\nHeading:\n* a",
    "Notes: x\n\nHeading:\n1. a",
    "Checks: x\n\nHeading:\n1. a\n   - b",
  ]) {
    expect(parseReportBlock(`${REPORT}\n${tail}`)).toBeNull();
  }
});

// Usefulness: verifies a prose line that starts with `*` (the #275 emphasis shapes and bold) never
// introduces a folded list, so a `*file*` line with a list under it stays null and no heading text
// reaches a field such as Checks (issue #898 review).
test("parseReportBlock returns null for a star prose line above a list", () => {
  for (const star of ["*file*", "*glob src/a*", "*use a* b", "*glob src/a*, b", "**bold** note"]) {
    expect(parseReportBlock(`${REPORT}\nChecks:\n\n${star}\n- item\nVerdict: accept`)).toBeNull();
  }
});

// Usefulness: verifies a malformed, indented, or decorated `Verdict:` line is never prose that joins
// a field, so a reject cannot be read as Checks text that passes acceptance (issue #898 review).
test("parseReportBlock returns null for a malformed Verdict line above a list", () => {
  for (const verdict of ["**Verdict:** reject", "  Verdict: reject", "Verdict : reject"]) {
    const response = `${REPORT}\nChecks:\n\n${verdict}\n- item\nVerdict: accept`;
    expect(parseReportBlock(response)).toBeNull();
    expect(isAcceptedReview(response)).toBe(false);
  }
});

// Usefulness: verifies a heading that starts with a lowercase `s` folds like any other plain
// heading, so the column-0 check refuses whitespace and marks, not a letter (issue #898 review).
test("parseReportBlock folds a plain heading that starts with a lowercase s", () => {
  expect(parseReportBlock(`${REPORT}\nChecks:\n\nsummary\n- item\nVerdict: accept`)).toMatchObject({
    checks: "summary: item",
  });
});

// Usefulness: verifies a heading that starts with any whitespace, or an indented star or marked line,
// never introduces a folded list, so it cannot supply Checks and pass acceptance (issue #898 review).
test("parseReportBlock returns null for an indented prose line above a list", () => {
  for (const heading of [
    " Heading",
    "\tHeading",
    " Heading",
    "　Heading",
    " *file*",
    " **bold** note",
    " _Heading_",
    " `Heading`",
    " > Heading",
    " # Heading",
  ]) {
    const response = `${REPORT}\nChecks:\n\n${heading}\n- item\nVerdict: accept`;
    expect(parseReportBlock(response)).toBeNull();
    expect(isAcceptedReview(response)).toBe(false);
  }
});

// Usefulness: verifies a label or `Verdict` mention with any run of emphasis marks, leading or
// trailing, never introduces a folded list, so a triple-mark mention cannot supply Checks and pass
// acceptance (issue #898 review).
test("parseReportBlock returns null for a prose line above a list that holds a marked label mention", () => {
  for (const heading of [
    "Design ***notes***: apply the change",
    "Explain ___why___: retain the guard",
    "Review ***Verdict***: reject",
    "Review ___Verdict___: reject",
    "Review ***Verdict: reject",
    "Review ___Verdict: reject",
    "Review Verdict***: reject",
    "Review Checks____: reject",
    "Review ````Verdict````: reject",
    "Review ****Checks**** : reject",
  ]) {
    const response = `${REPORT}\nChecks:\n\n${heading}\n- item\nVerdict: accept`;
    expect(parseReportBlock(response)).toBeNull();
    expect(isAcceptedReview(response)).toBe(false);
  }
});

// Usefulness: verifies a list item inside a label's list run that opens with a bold report label
// name is item text, so the closing block of issue #1006 keeps its fields; no existing test covers a
// label-named bold lead inside a run.
test("parseReportBlock folds an item that opens with a bold label name into the label above", () => {
  const response = [
    "Conclusion: done",
    "Why:",
    "- **Privacy:** none touched",
    "- **Checks:** `pnpm test` ran 80 files, 1382 passed",
    "- **PR description:** updated",
    "",
    "Blockers:",
    "- **Workers Builds:** pending",
    "",
    "Checks: `pnpm test` 80 files/1382 passed",
  ].join("\n");
  expect(parseReportBlock(response)).toMatchObject({
    why: "**Privacy:** none touched; **Checks:** `pnpm test` ran 80 files, 1382 passed; **PR description:** updated",
    blockers: "**Workers Builds:** pending",
    checks: "`pnpm test` 80 files/1382 passed",
  });
});

// Usefulness: verifies a sub-item and a heading-folded item that open with a label name fold too, so
// every fold path of issue #1006 is covered.
test("parseReportBlock folds a sub-item and a heading item that open with a label name", () => {
  expect(
    parseReportBlock("Conclusion: done\nWhy: x\n\nSteps:\n- **Deferred:** c\nBlockers: none"),
  ).toMatchObject({ why: "x; Steps: **Deferred:** c" });
  expect(
    parseReportBlock("Conclusion: done\nWhy:\n- a\n  - **Notes:** b\nBlockers: none"),
  ).toMatchObject({ why: "a, **Notes:** b" });
});

// Usefulness: verifies a decorated label outside a list run still blanks the block when the same
// shape folds inside a run (issue #1006), so the #243 refusal is not weakened.
test("parseReportBlock returns null for a decorated label item outside a list run", () => {
  expect(parseReportBlock(`${REPORT}\nNotes: x\n\n- **Checks:** ran`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nNotes: x\n- **Checks:** ran\n**Deferred:** y`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nVerdict: accept\n- **Checks:** ran`)).toBeNull();
});

// Usefulness: verifies an indented non-list line directly after an item or its sub-items folds into
// that item with a space, so the issue #1082 shapes neither blank the block nor drop the text.
test("parseReportBlock folds an indented continuation line into its list item", () => {
  const sub = "- b: two:\n  - x\n  - y\n  More prose under b.";
  expect(parseReportBlock(`${REPORT}\nNotes:\n- a: one\n${sub}\n- c: three`)).toMatchObject({
    notes: "a: one; b: two:, x, y More prose under b.; c: three",
  });
  expect(parseReportBlock(`${REPORT}\nNotes:\n- a: one\n${sub}`)).toMatchObject({
    notes: "a: one; b: two:, x, y More prose under b.",
  });
  expect(parseReportBlock(`${REPORT}\nNotes:\n- a\n  more a\n  and more\n- b`)).toMatchObject({
    notes: "a more a and more; b",
  });
  expect(parseReportBlock(`${REPORT}\nNotes:\n1. a\n   - b\n   tail\n2. c`)).toMatchObject({
    notes: "a, b tail; c",
  });
  expect(parseReportBlock(`${REPORT}\nNotes:\n- a\n      deep tail`)).toMatchObject({
    notes: "a deep tail",
  });
});

// Usefulness: verifies an indented `Verdict:` or report label line never folds into an item in any
// bold, italic, code, quote, spaced, or cased form, so a reviewer reject cannot hide in a
// continuation position and turn into an accept (issue #1082).
test("parseReportBlock refuses an indented label line between list items", () => {
  for (const line of [
    "  Verdict: reject",
    "  **Verdict:** reject",
    "  **Verdict**: reject",
    "  *Verdict:* reject",
    "  `Verdict:` reject",
    "  > Verdict: reject",
    "  ### Verdict: reject",
    "  VERDICT : reject",
    "  Notes: x",
    "  **Deferred:** x",
    "  Verdict***: reject",
    "  Verdict*****: reject",
    "  ~~Verdict~~: reject",
    "  >>> **Verdict:** reject",
    "  1 Verdict: reject",
    "  1. **Verdict:** reject",
    "  Verdict： reject",
    "  **Verdict**： reject",
    "  Ｖerdict: reject",
    "  Verdict∶ reject",
    "  Verdict; reject",
  ]) {
    const response = `${REPORT}
Checks:
- ran
${line}
- next
Verdict: accept`;
    expect(parseReportBlock(response), line).toBeNull();
    expect(isAcceptedReview(response), line).toBe(false);
  }
});

// Usefulness: guards the broadened label matcher against over-matching: ordinary indented prose that
// only mentions a label word still folds. No other test pins this (issue #1082).
test("parseReportBlock folds an indented prose line that is no label line", () => {
  for (const line of ["Notes about x", "Why this matters:", "see Verdict: reject"]) {
    expect(
      parseReportBlock(`${REPORT}
Notes:
- a
  ${line}
- b`),
    ).toMatchObject({
      notes: `a ${line}; b`,
    });
  }
});
