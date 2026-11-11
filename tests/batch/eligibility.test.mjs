import { expect, test } from "vite-plus/test";
import {
  checkEligibility,
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
      if (args.includes("state,blockedBy,body")) {
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
  expect(issueReads[0]).toContain("state,blockedBy,body");
});

// Usefulness: a cached repository slug skips the repo view on the next closure read.
test("a cached repository slug skips the repository read", async () => {
  let repositoryReads = 0;
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 5, closingIssuesReferences: [], headRefName: "b" }]),
        stderr: "",
      };
    }
    if (args[0] === "repo" && args[1] === "view") {
      repositoryReads += 1;
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "api") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const first = await readOpenPrClosures({ gh, repo: "C:\\repo" });
  await readOpenPrClosures({ gh, repo: "C:\\repo", slug: first.slug });
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
        stdout: JSON.stringify([{ number: 42, closingIssuesReferences: [] }]),
        stderr: "",
      };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
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
        stdout: JSON.stringify([{ number: 5, closingIssuesReferences: [] }]),
        stderr: "",
      };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
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
