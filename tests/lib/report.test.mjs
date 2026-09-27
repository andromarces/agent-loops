import { expect, test } from "vitest";
import { parseReportBlock, parseVerdict } from "../../src/lib/report.mjs";

const REPORT = "Conclusion: done\nWhy: tests pass\nBlockers: none";

// Usefulness: verifies parseReportBlock extracts the required labels and
// defaults the optional notes and deferred labels to null when absent, so a
// response in the pre-#214 format stays parseable (issue #214).
test("parseReportBlock extracts the closing block and defaults optional labels", () => {
  expect(parseReportBlock(REPORT)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
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
    notes: "tidy the helper later",
    deferred: "migrate the legacy path",
  });
});

// Usefulness: verifies a present-but-empty optional label maps to null rather
// than a misleading empty string.
test("parseReportBlock maps an empty optional label to null", () => {
  expect(parseReportBlock(`${REPORT}\nNotes:\nDeferred:`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    notes: null,
    deferred: null,
  });
});

// Usefulness: verifies an empty optional label with a list below it does not
// silently drop the list; the whole block is unparseable, so the dispatch layer
// falls back to `raw` and the list stays visible (issue #229).
test("parseReportBlock returns null when an empty optional label has a following list", () => {
  expect(parseReportBlock(`${REPORT}\nNotes:\n- item one\n- item two`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nNotes: none\nDeferred:\n- item one`)).toBeNull();
  expect(parseReportBlock(`${REPORT}\nNotes:\n1. item one`)).toBeNull();
});

// Usefulness: verifies a non-list line after an empty optional label, for
// example a closing sentence or a lone code fence, does not make the block
// unparseable; only a list that would be dropped is flagged (issue #229).
test("parseReportBlock keeps a block whose empty optional label only a non-list line follows", () => {
  expect(parseReportBlock(`${REPORT}\nDeferred:\nLet me know if the fix looks right.`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    notes: null,
    deferred: null,
  });
  expect(parseReportBlock(`${REPORT}\nDeferred:\n\`\`\``)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
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
    notes: null,
    deferred: "migrate the legacy path",
  });
  expect(parseReportBlock(`${REPORT}\nNotes:\nDeferred:\nVerdict: accept`)).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    notes: null,
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
      "conclusion: done\nWHY: tests pass\nblockers: none\nnotes: later\ndeferred: out",
    ),
  ).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
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
