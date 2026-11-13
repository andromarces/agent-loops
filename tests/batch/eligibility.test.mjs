import { expect, test } from "vite-plus/test";
import {
  checkEligibility,
  closingIssueNumbers,
  hasStructuralMinimum,
  readOpenPrClosures,
} from "../../src/batch/eligibility.mjs";

const BODY_OK = ["## Problem", "Missing.", "", "## Acceptance", "", "- one check", ""].join("\n");

function issueReply(state, { body = BODY_OK, blocked = [] } = {}) {
  return (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body,title")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state, blockedBy: { nodes: blocked }, body }),
          stderr: "",
        };
      }
      if (args.includes("blockedBy")) {
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: blocked } }), stderr: "" };
      }
      if (args.includes("body")) {
        return { status: 0, stdout: JSON.stringify({ body }), stderr: "" };
      }
      if (args.includes("state") && args.includes("closedByPullRequestsReferences")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state, closedByPullRequestsReferences: [] }),
          stderr: "",
        };
      }
      return { status: 0, stdout: JSON.stringify({ state }), stderr: "" };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

// Usefulness: one eligibility check reads the state, blockers, and body in one gh call.
test("one eligibility check reads the issue once", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] }, body: BODY_OK }),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const result = await checkEligibility({
    issue: 7,
    gh,
    repo: "C:\\repo",
    claim: { exists: false },
    openPrClosures: { closed: new Set(), incompletePr: null },
    requireSpecification: true,
  });
  expect(result.ok).toBe(true);
  const issueReads = calls.filter((args) => args[0] === "issue" && args[1] === "view");
  expect(issueReads).toHaveLength(1);
  expect(issueReads[0]).toContain("state,blockedBy,body,title");
});

// Usefulness: a cached repository read skips both the name and default branch on the next read.
test("a cached repository read skips the repository read", async () => {
  let repositoryReads = 0;
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 5,
            closingIssuesReferences: [],
            headRefName: "b",
            baseRefName: "main",
            body: "",
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "repo" && args[1] === "view") {
      repositoryReads += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "o/r",
          defaultBranchRef: { name: "main" },
        }),
        stderr: "",
      };
    }
    if (args[0] === "api") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const first = await readOpenPrClosures({ gh, repo: "C:\\repo" });
  await readOpenPrClosures({ gh, repo: "C:\\repo", repository: first.repository });
  expect(repositoryReads).toBe(1);
});

// Usefulness: a closed issue is skipped with the named reason and launches no child.
test("a closed issue is skipped", async () => {
  const result = await checkEligibility({
    issue: 7,
    gh: issueReply("CLOSED"),
    repo: "C:\\repo",
    claim: { exists: false },
    openPrClosures: { closed: new Set(), incompletePr: null },
  });
  expect(result).toMatchObject({ ok: false, reason: "closed" });
});

// Usefulness: a blocked issue names the open issue numbers.
test("a blocked issue reports the blocking numbers", async () => {
  const result = await checkEligibility({
    issue: 7,
    gh: issueReply("OPEN", { blocked: [{ number: 2, state: "OPEN" }] }),
    repo: "C:\\repo",
    claim: { exists: false },
    openPrClosures: { closed: new Set(), incompletePr: null },
  });
  expect(result).toMatchObject({ ok: false, reason: "blocked" });
  expect(result.evidence).toContain("2");
});

// Usefulness: a closed blocking issue is not a block.
test("a closed blocking issue does not skip", async () => {
  const result = await checkEligibility({
    issue: 7,
    gh: issueReply("OPEN", { blocked: [{ number: 2, state: "CLOSED" }] }),
    repo: "C:\\repo",
    claim: { exists: false },
    openPrClosures: { closed: new Set(), incompletePr: null },
  });
  expect(result.ok).toBe(true);
});

// Usefulness: a live claim of another batch is reported with the owning batch.
test("a claimed issue names the owning batch", async () => {
  const result = await checkEligibility({
    issue: 7,
    gh: issueReply("OPEN"),
    repo: "C:\\repo",
    claim: { exists: true, held: true, parsed: true, record: { batchId: "other" } },
    openPrClosures: { closed: new Set(), incompletePr: null },
  });
  expect(result).toMatchObject({ ok: false, reason: "claimed" });
  expect(result.evidence).toContain("other");
});

// Usefulness: a claim of the current batch is not a skip on a resume.
test("a claim of the current batch is not a skip", async () => {
  const result = await checkEligibility({
    issue: 7,
    gh: issueReply("OPEN"),
    repo: "C:\\repo",
    batchId: "mine",
    claim: { exists: true, held: true, parsed: true, record: { batchId: "mine" } },
    openPrClosures: { closed: new Set(), incompletePr: null },
  });
  expect(result.ok).toBe(true);
});

// Usefulness: an issue closed by an open pull request body is skipped.
test("an issue closed by an open pull request is skipped", async () => {
  const result = await checkEligibility({
    issue: 7,
    gh: issueReply("OPEN"),
    repo: "C:\\repo",
    claim: { exists: false },
    openPrClosures: { closed: new Set([7]), pr: 42, incompletePr: null },
  });
  expect(result).toMatchObject({ ok: false, reason: "closed-by-open-pr" });
  expect(result.evidence).toContain("42");
});

// Usefulness: the structural minimum needs an acceptance list and a problem or scope heading.
test("an issue with no acceptance section is skipped", () => {
  expect(hasStructuralMinimum("## Problem\n\nText.\n")).toBe(false);
  expect(hasStructuralMinimum("## Acceptance\n\n- one\n")).toBe(false);
  expect(hasStructuralMinimum(BODY_OK)).toBe(true);
});

// Usefulness: an unreadable read is never treated as eligible.
test("a failed read is eligibility-unverified", async () => {
  const gh = () => {
    throw new Error("gh failed");
  };
  const result = await checkEligibility({
    issue: 7,
    gh,
    repo: "C:\\repo",
    claim: { exists: false },
    openPrClosures: { closed: new Set(), incompletePr: null },
  });
  expect(result).toMatchObject({ ok: false, reason: "eligibility-unverified" });
});

// Usefulness: a pull request that reaches the 250-commit page stops the queue.
test("a 250-commit page stops the queue", async () => {
  const commit = (n) => ({
    commit: { message: n % 50 === 0 ? "closes #9" : `commit ${n}` },
  });
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { number: 42, closingIssuesReferences: [], baseRefName: "main", body: "" },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }),
        stderr: "",
      };
    }
    if (args[0] === "api" && args[1].includes("/pulls/42/commits")) {
      const page = Number(new URL(`https://x/${args[1]}`).searchParams.get("page"));
      const count = page < 3 ? 100 : 50;
      return {
        status: 0,
        stdout: JSON.stringify(
          Array.from({ length: count }, (_, i) => commit((page - 1) * 100 + i)),
        ),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const closures = await readOpenPrClosures({ gh, repo: "C:\\repo" });
  expect(closures.incompletePr).toBe(42);
});

// Usefulness: a closing keyword in a commit message closes the issue.
test("a closing keyword in a commit message is read", async () => {
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { number: 5, closingIssuesReferences: [], baseRefName: "main", body: "" },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }),
        stderr: "",
      };
    }
    if (args[0] === "api") {
      return {
        status: 0,
        stdout: JSON.stringify([{ commit: { message: "Fix #12 now" } }]),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const closures = await readOpenPrClosures({ gh, repo: "C:\\repo" });
  expect([...closures.closed]).toEqual([12]);
  expect(closures.incompletePr).toBe(null);
});

/** The gh double of a closure read over `entries` on repository `o/r`, with default branch `main`. */
function closureGh(entries, { defaultBranch = "main" } = {}) {
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify(entries), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      const reply = { nameWithOwner: "o/r" };
      if (defaultBranch !== null) reply.defaultBranchRef = { name: defaultBranch };
      return { status: 0, stdout: JSON.stringify(reply), stderr: "" };
    }
    if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

// Usefulness: every closing keyword form, an optional colon, and case differences close the issue.
test("the parser reads every closing keyword form and an optional colon", () => {
  for (const keyword of [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ]) {
    expect(closingIssueNumbers(`${keyword} #7`, "o/r"), keyword).toEqual([7]);
    expect(closingIssueNumbers(`${keyword}: #7`, "o/r"), keyword).toEqual([7]);
  }
  expect(closingIssueNumbers("CLOSES #7", "o/r")).toEqual([7]);
});

// Usefulness: this repository's three reference forms close an issue, and a reference to another
// repository never does.
test("the parser reads this repository's reference forms only", () => {
  expect(closingIssueNumbers("Closes #7", "o/r")).toEqual([7]);
  expect(closingIssueNumbers("Fixes O/R#7", "o/r")).toEqual([7]);
  expect(closingIssueNumbers("Resolves https://github.com/o/r/issues/7", "o/r")).toEqual([7]);
  expect(closingIssueNumbers("Closes other/repo#7", "o/r")).toEqual([]);
  expect(closingIssueNumbers("Closes https://github.com/other/repo/issues/7", "o/r")).toEqual([]);
  expect(closingIssueNumbers("Closes #12abc", "o/r")).toEqual([]);
  expect(closingIssueNumbers("Closes https://github.com/o/r/issues/12/x", "o/r")).toEqual([]);
});

// Usefulness: a negated closing phrase still names the issue, as GitHub links it on a default base.
test("the parser reads a negated closing phrase", () => {
  expect(closingIssueNumbers("This does not fix #7 yet", "o/r")).toEqual([7]);
});

// Usefulness: a keyword inside an inline code span is not a closure, across a line or a longer run.
test("an inline code span hides a closing keyword", () => {
  expect(closingIssueNumbers("`Closes #7`", "o/r")).toEqual([]);
  expect(closingIssueNumbers("Closes `#7`", "o/r")).toEqual([]);
  expect(closingIssueNumbers("`Closes\n#7`", "o/r")).toEqual([]);
  expect(closingIssueNumbers("``Closes `#7` again``", "o/r")).toEqual([]);
});

// Usefulness: a fenced block hides a keyword for backtick and tilde fences, lengths, and no info string.
test("a fenced code block hides a closing keyword", () => {
  expect(closingIssueNumbers("```\nCloses #7\n```\n", "o/r")).toEqual([]);
  expect(closingIssueNumbers("~~~\nCloses #7\n~~~\n", "o/r")).toEqual([]);
  expect(closingIssueNumbers("````\n```js\nCloses #7\n````\n", "o/r")).toEqual([]);
  expect(closingIssueNumbers("   ```\nCloses #7\n   ```\n", "o/r")).toEqual([]);
  expect(closingIssueNumbers("```\nCloses #7\n", "o/r")).toEqual([]);
});

// Usefulness: an indented code block hides a keyword, while a paragraph continuation keeps it.
test("an indented code block hides a closing keyword", () => {
  expect(closingIssueNumbers("    Closes #7\n", "o/r")).toEqual([]);
  expect(closingIssueNumbers("\tCloses #7\n", "o/r")).toEqual([]);
  expect(closingIssueNumbers("Closes #6\n\n    Closes #7\n", "o/r")).toEqual([6]);
  expect(closingIssueNumbers("Text\n    Closes #7\n", "o/r")).toEqual([7]);
});

// Usefulness: a heading, break, comment, fence close, or blank line leaves no paragraph.
test("a block start leaves no open paragraph for an indented line", () => {
  const bodies = [
    "## Closing syntax example\n    Closes #7",
    "Text\n## Closing syntax example\n    Closes #7",
    "---\n    Closes #7",
    "Text\n---\n    Closes #7",
    "<!-- note -->\n    Closes #7",
    "```\ncode\n```\n    Closes #7",
    "Text\n\n    Closes #7",
  ];
  for (const body of bodies) expect(closingIssueNumbers(body, "o/r"), body).toEqual([]);
});

// Usefulness: a list item content column keeps its indented lines as item text, and code stays code.
test("a list item content column keeps indented lines in the item", () => {
  expect(closingIssueNumbers("- item\n    Closes #7", "o/r")).toEqual([7]);
  expect(closingIssueNumbers("- item\n\n  Closes #7", "o/r")).toEqual([7]);
  expect(closingIssueNumbers("- item\n\n      Closes #7", "o/r")).toEqual([]);
  expect(closingIssueNumbers("1. item\n   Closes #7", "o/r")).toEqual([7]);
});

// Usefulness: a fence, quote, heading, or nested list inside a list item follows the top-level rules.
test("a block inside a list item follows the top-level rules", () => {
  expect(closingIssueNumbers("- ```text\n  Closes #7\n  ````", "o/r")).toEqual([]);
  expect(closingIssueNumbers("- > Closes #7", "o/r")).toEqual([]);
  expect(closingIssueNumbers("- ## Example\n      Closes #7", "o/r")).toEqual([]);
  expect(closingIssueNumbers("- a\n  - b\n    Closes #7", "o/r")).toEqual([7]);
});

// Usefulness: a block quote line hides a keyword with up to three leading spaces.
test("a block quote hides a closing keyword", () => {
  expect(closingIssueNumbers("> Closes #7\n", "o/r")).toEqual([]);
  expect(closingIssueNumbers("   > Closes #7\n", "o/r")).toEqual([]);
});

// Usefulness: a lazy continuation line stays in the block quote until a blank line or block start.
test("a lazy block quote continuation hides a closing keyword", () => {
  expect(closingIssueNumbers("> The previous PR said:\nCloses #7", "o/r")).toEqual([]);
  expect(closingIssueNumbers("> The previous PR said:\nCloses #7\n\nCloses #8", "o/r")).toEqual([
    8,
  ]);
  expect(closingIssueNumbers("> The previous PR said:\n## Heading\nCloses #8", "o/r")).toEqual([8]);
});

// Usefulness: an HTML comment hides a keyword across lines, and an unclosed comment runs to the end.
test("an HTML comment hides a closing keyword", () => {
  expect(closingIssueNumbers("<!-- Closes #7 -->", "o/r")).toEqual([]);
  expect(closingIssueNumbers("<!--\nCloses #7\n-->", "o/r")).toEqual([]);
  expect(closingIssueNumbers("<!-- Closes #7", "o/r")).toEqual([]);
  expect(closingIssueNumbers("<!-- note --> Closes #8", "o/r")).toEqual([8]);
});

// Usefulness: a CRLF body reads the same keyword and ignored comment as an LF body.
test("the parser reads a CRLF body", () => {
  expect(closingIssueNumbers("Closes #7\r\n<!-- Closes #8 -->\r\n", "o/r")).toEqual([7]);
});

// Usefulness: a non-default-base PR body skips the issue it closes and names the PR as source.
test("a non-default-base PR body closes the issue", async () => {
  const gh = closureGh(
    [
      {
        number: 42,
        headRefName: "b",
        closingIssuesReferences: [],
        baseRefName: "develop",
        body: "Closes #7",
      },
    ],
    { defaultBranch: "main" },
  );
  const closures = await readOpenPrClosures({ gh, repo: "C:\\repo" });
  expect([...closures.closed]).toEqual([7]);
  expect(closures.sources.get(7)).toEqual([{ number: 42, headRefName: "b" }]);
  expect(closures.repository).toEqual({ nameWithOwner: "o/r", defaultBranch: "main" });
});

// Usefulness: a default-base PR body is never parsed, as GitHub alone records that link.
test("a default-base PR body is not a skip source", async () => {
  const gh = closureGh(
    [
      {
        number: 42,
        headRefName: "b",
        closingIssuesReferences: [],
        baseRefName: "main",
        body: "Closes #7",
      },
    ],
    { defaultBranch: "main" },
  );
  const closures = await readOpenPrClosures({ gh, repo: "C:\\repo" });
  expect([...closures.closed]).toEqual([]);
});

// Usefulness: a malformed base, body, or default branch reply fails closed instead of skipping.
test("a malformed body read fails closed", async () => {
  const base = {
    number: 42,
    headRefName: "b",
    closingIssuesReferences: [],
    baseRefName: "develop",
    body: "",
  };
  await expect(
    readOpenPrClosures({
      gh: closureGh([{ ...base, baseRefName: null }]),
      repo: "C:\\repo",
    }),
  ).rejects.toThrow();
  await expect(
    readOpenPrClosures({ gh: closureGh([{ ...base, body: null }]), repo: "C:\\repo" }),
  ).rejects.toThrow();
  await expect(
    readOpenPrClosures({ gh: closureGh([base], { defaultBranch: null }), repo: "C:\\repo" }),
  ).rejects.toThrow();
});

// Usefulness: a non-string body on a default-base entry fails closed even though its body is not parsed.
test("a default-base entry with a non-string body fails closed", async () => {
  const gh = closureGh([
    {
      number: 42,
      headRefName: "b",
      closingIssuesReferences: [],
      baseRefName: "main",
      body: null,
    },
  ]);
  await expect(readOpenPrClosures({ gh, repo: "C:\\repo" })).rejects.toThrow();
});
