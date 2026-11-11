import { expect, test } from "vite-plus/test";
import { parseFindings } from "../../src/batch/audit-prompts.mjs";

function fenced(value) {
  return `Reasoning before the document.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

// Usefulness: the findings parser accepts the fenced document.
// It rejects prose, so a malformed audit is a failure rather than an empty success.
test("findings parse only from a valid fenced document", () => {
  expect(parseFindings("no document")).toBeNull();
  expect(parseFindings(fenced({ findings: [] }))).toEqual([]);
  expect(parseFindings(fenced({ findings: [{ title: "T", body: "B", evidence: "E" }] }))).toEqual([
    { title: "T", body: "B", evidence: "E", existingIssue: null },
  ]);
  expect(parseFindings(fenced({ findings: [{ title: "", body: "B" }] }))).toBeNull();
});
