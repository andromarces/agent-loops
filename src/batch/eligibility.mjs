// Eligibility refresh before each launch (ADR 0106 decision 6). The runtime selects no issue;
// these checks only skip one, and each skip names its evidence. A batch-wide read that fails
// pauses the queue instead.
import { isJsonObject } from "../lib/json.mjs";

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

async function readJson(gh, args, cwd) {
  const reply = await gh(args, cwd);
  if (reply === undefined || reply === null) throw new Error("the read returned nothing");
  if (reply.status !== 0) {
    throw new Error((reply.stderr ?? "").trim() || `exit ${reply.status}`);
  }
  return JSON.parse(reply.stdout);
}

function blockedNumbers(value) {
  if (Array.isArray(value)) return value;
  if (isJsonObject(value)) {
    if (Array.isArray(value.nodes)) return value.nodes;
    if (Array.isArray(value.issues)) return value.issues;
  }
  return null;
}

const isOpen = (state) => String(state).toUpperCase() === "OPEN";

// The text of a `gh pr view` reply that proves the number is not a pull request. Any other failed
// reply is a failed lookup and never falls through to the issue read.
const PR_NOT_FOUND = /could not resolve to a pull ?request/i;

async function probePullRequest(gh, number, repo) {
  let reply;
  try {
    reply = await gh(["pr", "view", String(number), "--json", "number"], repo);
  } catch (err) {
    return { kind: "failed", detail: err?.message ?? String(err) };
  }
  if (reply?.status === 0) {
    try {
      const value = JSON.parse(reply.stdout);
      if (isJsonObject(value) && Number.isInteger(value.number)) return { kind: "pr" };
    } catch {
      // A successful reply that is not a number is a failed lookup.
    }
    return { kind: "failed", detail: "the reply named no pull request number" };
  }
  const text = `${reply?.stderr ?? ""} ${reply?.stdout ?? ""}`.trim();
  if (PR_NOT_FOUND.test(text)) return { kind: "none" };
  return { kind: "failed", detail: text || `exit ${reply?.status ?? "unknown"}` };
}

/** One `## Acceptance` heading with at least one list item, and a `## Problem` or `## Scope`. */
export function hasStructuralMinimum(body) {
  if (typeof body !== "string") return false;
  const lines = body.split(/\r?\n/);
  const headings = new Set();
  let acceptanceItems = 0;
  let inAcceptance = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      headings.add(heading[1]);
      inAcceptance = heading[1] === "Acceptance";
      continue;
    }
    if (inAcceptance && LIST_ITEM.test(line)) acceptanceItems += 1;
  }
  return (
    headings.has("Acceptance") &&
    acceptanceItems > 0 &&
    (headings.has("Problem") || headings.has("Scope"))
  );
}

/**
 * Reads every open pull request and the issues its body or commit messages close. Throws when a
 * batch-wide read fails, so the caller pauses the queue. `incompletePr` names a pull request whose
 * commit read reached the API's 250-commit page. The caller then stops launching. `slug` is the
 * repository name, read when it is null and returned for the next call.
 * @returns {Promise<{ closed: Set<number>, pr: number | null, incompletePr: number | null, slug: string | null }>}
 */
export async function readOpenPrClosures({ gh, repo, slug = null }) {
  const list = await readJson(
    gh,
    [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,closingIssuesReferences,headRefName",
      "--limit",
      "1000",
    ],
    repo,
  );
  if (!Array.isArray(list)) throw new Error("gh pr list returned no list");
  const closed = new Set();
  const sources = new Map();
  const addSource = (issueNumber, entry) => {
    const listForIssue = sources.get(issueNumber) ?? [];
    if (!listForIssue.some((source) => source.number === entry.number)) {
      listForIssue.push({ number: entry.number, headRefName: entry.headRefName ?? null });
      sources.set(issueNumber, listForIssue);
    }
  };
  for (const entry of list) {
    if (!isJsonObject(entry) || !Number.isInteger(entry.number)) {
      throw new Error("gh pr list returned a malformed entry");
    }
    const references = entry.closingIssuesReferences;
    if (references !== undefined && !Array.isArray(references)) {
      throw new Error("gh pr list returned malformed closing references");
    }
    for (const reference of references ?? []) {
      if (Number.isInteger(reference?.number)) {
        closed.add(reference.number);
        addSource(reference.number, entry);
      }
    }
  }
  if (list.length === 0) return { closed, pr: null, incompletePr: null, sources, slug };

  let repositorySlug = slug;
  if (repositorySlug === null) {
    const repository = await readJson(gh, ["repo", "view", "--json", "nameWithOwner"], repo);
    if (!isJsonObject(repository) || typeof repository.nameWithOwner !== "string") {
      throw new Error("gh repo view returned no repository name");
    }
    repositorySlug = repository.nameWithOwner;
  }
  let incompletePr = null;
  for (const entry of list) {
    let count = 0;
    for (let page = 1; page <= 3 && count < 250; page += 1) {
      const commits = await readJson(
        gh,
        ["api", `repos/${repositorySlug}/pulls/${entry.number}/commits?per_page=100&page=${page}`],
        repo,
      );
      if (!Array.isArray(commits)) throw new Error("the commit read returned no list");
      if (commits.length === 0) break;
      count += commits.length;
      for (const item of commits) {
        const message = item?.commit?.message;
        if (typeof message !== "string") continue;
        for (const match of message.matchAll(CLOSING_KEYWORD)) {
          const number = Number(match[1]);
          closed.add(number);
          addSource(number, entry);
        }
      }
      if (commits.length < 100) break;
    }
    if (count >= 250) {
      incompletePr = entry.number;
      break;
    }
  }
  const first = [...closed].sort((a, b) => a - b)[0];
  const firstSource = first === undefined ? null : (sources.get(first)?.[0]?.number ?? null);
  return { closed, pr: firstSource, incompletePr, sources, slug: repositorySlug };
}

/**
 * Applies the eligibility checks of decision 6 in order for one issue. `claim` is the result of
 * `readClaim`; `openPrClosures` is the result of `readOpenPrClosures`, or null while that read is
 * not needed.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, evidence: string }>}
 */
export async function checkEligibility({
  issue,
  gh,
  repo,
  batchId = null,
  claim,
  openPrClosures,
  ownPr = null,
  ownBranch = null,
  requireSpecification = false,
}) {
  const unverified = (detail) => ({
    ok: false,
    reason: "eligibility-unverified",
    evidence: `the read failed: ${detail}`,
  });
  const probe = await probePullRequest(gh, issue, repo);
  if (probe.kind === "pr") {
    return {
      ok: false,
      reason: "is-pull-request",
      evidence: `number ${issue} is a pull request`,
    };
  }
  if (probe.kind === "failed") {
    return {
      ok: false,
      reason: "eligibility-unverified",
      evidence: `the pull request lookup failed: ${probe.detail}`,
    };
  }
  let issueView;
  try {
    issueView = await readJson(
      gh,
      ["issue", "view", String(issue), "--json", "state,blockedBy,body"],
      repo,
    );
  } catch (err) {
    return unverified(err.message);
  }
  if (!isJsonObject(issueView) || typeof issueView.state !== "string") {
    return unverified("the state reply named no state");
  }
  if (!isOpen(issueView.state)) {
    return { ok: false, reason: "closed", evidence: `the issue state is ${issueView.state}` };
  }

  const nodes = blockedNumbers(issueView.blockedBy);
  if (nodes === null) return unverified("the blockedBy reply is unreadable");
  const open = nodes
    .filter((node) => isJsonObject(node) && isOpen(node.state))
    .map((node) => node.number)
    .filter(Number.isInteger);
  if (open.length > 0) {
    return {
      ok: false,
      reason: "blocked",
      evidence: `open blocking issues: ${open.join(", ")}`,
      blocking: open,
    };
  }

  if (claim?.exists && claim.held && claim.record?.batchId !== batchId) {
    return {
      ok: false,
      reason: "claimed",
      evidence: `claimed by batch ${claim.record?.batchId ?? "unknown"}`,
    };
  }

  if (openPrClosures === null || openPrClosures === undefined) {
    return unverified("the open pull request read did not run");
  }
  if (openPrClosures.incompletePr !== null) {
    return {
      ok: false,
      reason: "eligibility-unverified",
      evidence: `pull request ${openPrClosures.incompletePr} returned a 250-commit page`,
    };
  }
  if (openPrClosures.closed.has(issue)) {
    const sources = openPrClosures.sources?.get(issue) ?? [];
    const own =
      sources.length > 0 &&
      sources.every(
        (source) =>
          (ownPr !== null && source.number === ownPr) ||
          (ownBranch !== null && source.headRefName === ownBranch),
      );
    if (!own) {
      return {
        ok: false,
        reason: "closed-by-open-pr",
        evidence: `pull request ${openPrClosures.pr ?? "unknown"} closes it`,
      };
    }
  }

  if (!requireSpecification) return { ok: true };

  if (typeof issueView.body !== "string") {
    return unverified("the body reply named no body");
  }
  if (!hasStructuralMinimum(issueView.body)) {
    return {
      ok: false,
      reason: "not-specified",
      evidence: "no acceptance list, or no problem and no scope heading",
    };
  }
  return { ok: true };
}

function claimSkip(claim, batchId) {
  if (claim?.exists && claim.held && claim.record?.batchId !== batchId) {
    return {
      ok: false,
      reason: "claimed",
      evidence: `claimed by batch ${claim.record?.batchId ?? "unknown"}`,
    };
  }
  return null;
}

/**
 * The start-time refusal of one item, before any batch store exists. A pull request gets its full
 * eligibility check; an issue gets only the pull request-number probe, so its normal launch-time
 * eligibility and waiting behavior stay unchanged. A task has no start-time refusal.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, evidence: string }>}
 */
export async function preflightItemEligibility({ item, gh, repo, batchId = null }) {
  if (item.kind === "pr") {
    return checkItemEligibility({ item, gh, repo, batchId, claim: { exists: false } });
  }
  if (item.kind !== "issue") return { ok: true };
  const probe = await probePullRequest(gh, item.number, repo);
  if (probe.kind === "pr") {
    return {
      ok: false,
      reason: "is-pull-request",
      evidence: `number ${item.number} is a pull request`,
    };
  }
  if (probe.kind === "failed") {
    return {
      ok: false,
      reason: "eligibility-unverified",
      evidence: `the pull request lookup failed: ${probe.detail}`,
    };
  }
  return { ok: true };
}

/**
 * Applies the eligibility checks of one item kind. An issue keeps its checks, a pull request
 * checks its state and frozen head, and a free-text task checks only its claim.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, evidence: string }>}
 */
export async function checkItemEligibility(options) {
  const { item, gh, repo, batchId = null, claim } = options;
  if (item.kind === "issue") {
    return checkEligibility({
      ...options,
      issue: item.number,
      requireSpecification: options.requireSpecification === true,
    });
  }
  if (item.kind === "task") {
    return claimSkip(claim, batchId) ?? { ok: true };
  }
  if (typeof item.head !== "string" || item.head.trim() === "") {
    return {
      ok: false,
      reason: "pr-head-unfrozen",
      evidence: "the pull request head was not frozen at start",
    };
  }
  const unverified = (detail) => ({
    ok: false,
    reason: "eligibility-unverified",
    evidence: `the read failed: ${detail}`,
  });
  let view;
  try {
    view = await readJson(
      gh,
      [
        "pr",
        "view",
        String(item.number),
        "--json",
        "state,headRefOid,headRefName,isCrossRepository",
      ],
      repo,
    );
  } catch (err) {
    return unverified(err.message);
  }
  if (!isJsonObject(view) || typeof view.state !== "string") {
    return unverified("the pull request reply named no state");
  }
  if (!isOpen(view.state)) {
    return {
      ok: false,
      reason: "pr-closed",
      evidence: `the pull request state is ${view.state}`,
    };
  }
  if (view.isCrossRepository === true && item.mode !== "review-only") {
    return {
      ok: false,
      reason: "pr-head-foreign",
      evidence: `the head of pull request ${item.number} is in another repository`,
    };
  }
  const claimed = claimSkip(claim, batchId);
  if (claimed !== null) return claimed;
  if (typeof item.head === "string" && view.headRefOid !== item.head) {
    return {
      ok: false,
      reason: "pr-head-moved",
      evidence: `the frozen head is ${item.head}, the current head is ${view.headRefOid}`,
    };
  }
  return { ok: true };
}
