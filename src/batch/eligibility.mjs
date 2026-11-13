// Eligibility refresh before each launch (ADR 0106 decision 6). The runtime selects no issue;
// these checks only skip one, and each skip names its evidence. A batch-wide read that fails
// pauses the queue instead.
import { isJsonObject } from "../lib/json.mjs";
import { readGhJson } from "./gh-read.mjs";

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const BODY_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+/gi;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCK_LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const COMMENT_START = /^ {0,3}<!--/;

/** True for a line that starts a new block and so ends a paragraph or a quote continuation. */
function isBlockStart(line) {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    BLOCK_LIST_ITEM.test(line) ||
    COMMENT_START.test(line)
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskRange(ignored, start, end) {
  for (let index = start; index < end; index += 1) ignored[index] = true;
}

function fullyIgnored(ignored, start, end) {
  for (let index = start; index < end; index += 1) {
    if (!ignored[index]) return false;
  }
  return true;
}

/** Masks fenced and indented code blocks and block quote lines. */
function maskBlocks(body, ignored) {
  let offset = 0;
  let fence = null;
  let inQuote = false;
  let paragraph = false;
  for (const line of body.split("\n")) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    if (fence !== null) {
      maskRange(ignored, start, end);
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      paragraph = false;
      continue;
    }
    if (line.trim() === "") {
      paragraph = false;
      inQuote = false;
      continue;
    }
    if (inQuote && !/^ {0,3}>/.test(line)) {
      const lazy = !isBlockStart(line);
      if (lazy) {
        maskRange(ignored, start, end);
        continue;
      }
      inQuote = false;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
      fence = { char: open[2][0], length: open[2].length };
      maskRange(ignored, start, end);
      paragraph = false;
      inQuote = false;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      maskRange(ignored, start, end);
      paragraph = false;
      inQuote = true;
      continue;
    }
    if (isBlockStart(line)) {
      paragraph = false;
      inQuote = false;
      continue;
    }
    if (!paragraph && /^(?: {4}|\t)/.test(line)) {
      maskRange(ignored, start, end);
      paragraph = false;
      continue;
    }
    paragraph = true;
  }
}

/** Masks a backtick run through the next run of the same length inside one paragraph. */
function maskCodeSpans(body, ignored) {
  const lines = body.split("\n");
  let offset = 0;
  let runStart = null;
  let runEnd = null;
  const flush = () => {
    if (runStart === null) return;
    maskSpansInRun(body, runStart, runEnd, ignored);
    runStart = null;
    runEnd = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    const blockLine = line.trim() === "" || fullyIgnored(ignored, start, end);
    if (blockLine) {
      flush();
      continue;
    }
    if (runStart === null) runStart = start;
    runEnd = end;
  }
  flush();
}

function maskSpansInRun(body, start, end, ignored) {
  let index = start;
  while (index < end) {
    if (ignored[index] || body[index] !== "`") {
      index += 1;
      continue;
    }
    let openEnd = index;
    while (openEnd < end && body[openEnd] === "`") openEnd += 1;
    const length = openEnd - index;
    let scan = openEnd;
    let closeEnd = -1;
    while (scan < end) {
      if (ignored[scan] || body[scan] !== "`") {
        scan += 1;
        continue;
      }
      let runEnd = scan;
      while (runEnd < end && body[runEnd] === "`") runEnd += 1;
      if (runEnd - scan === length) {
        closeEnd = runEnd;
        break;
      }
      scan = runEnd;
    }
    if (closeEnd === -1) {
      index = openEnd;
      continue;
    }
    maskRange(ignored, index, closeEnd);
    index = closeEnd;
  }
}

/** Masks an HTML comment through its close, or to the end of an unclosed comment. */
function maskComments(body, ignored) {
  let index = 0;
  while (index < body.length) {
    if (ignored[index] || !body.startsWith("<!--", index)) {
      index += 1;
      continue;
    }
    const close = body.indexOf("-->", index + 4);
    const end = close === -1 ? body.length : close + 3;
    maskRange(ignored, index, end);
    index = end;
  }
}

/**
 * The issue numbers that `body` closes in `repository`. A keyword inside inline code, fenced or
 * indented code, a block quote, or an HTML comment names none.
 * @returns {number[]}
 */
export function closingIssueNumbers(body, repository) {
  if (typeof body !== "string" || typeof repository !== "string") return [];
  const [owner, name] = repository.split("/");
  if (!owner || !name) return [];
  const slug = `${escapeRegExp(owner)}/${escapeRegExp(name)}`;
  const reference = new RegExp(
    `^(?:#(\\d+)|${slug}#(\\d+)|https://github\\.com/${slug}/issues/(\\d+))(?!\\w|/)`,
    "i",
  );
  const ignored = Array.from({ length: body.length }, () => false);
  maskBlocks(body, ignored);
  maskCodeSpans(body, ignored);
  maskComments(body, ignored);
  let visible = "";
  for (let index = 0; index < body.length; index += 1) {
    visible += ignored[index] ? " " : body[index];
  }
  const closed = [];
  for (const match of visible.matchAll(BODY_KEYWORD)) {
    const found = reference.exec(visible.slice(match.index + match[0].length));
    if (!found) continue;
    const number = Number(found[1] ?? found[2] ?? found[3]);
    if (Number.isInteger(number) && number > 0) closed.push(number);
  }
  return [...new Set(closed)];
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
  let value;
  try {
    value = await readGhJson(gh, ["pr", "view", String(number), "--json", "number"], repo);
  } catch (err) {
    if (err?.kind === undefined) return { kind: "failed", detail: err?.message ?? String(err) };
    const reply = err.reply;
    const text = `${reply?.stderr ?? ""} ${reply?.stdout ?? ""}`.trim();
    if (err.kind === "status" && PR_NOT_FOUND.test(text)) return { kind: "none" };
    if (err.kind === "json") {
      return { kind: "failed", detail: "the reply named no pull request number" };
    }
    return { kind: "failed", detail: text || `exit ${reply?.status ?? "unknown"}` };
  }
  if (isJsonObject(value) && Number.isInteger(value.number)) return { kind: "pr" };
  return { kind: "failed", detail: "the reply named no pull request number" };
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
 * commit read reached the API's 250-commit page. The caller then stops launching. `repository` is
 * the cached name and default branch, read when it is null and returned for the next call.
 * @returns {Promise<{ closed: Set<number>, sources: Map<number, { number: number, headRefName: string | null }[]>, pr: number | null, incompletePr: number | null, repository: { nameWithOwner: string, defaultBranch: string } | null }>}
 */
export async function readOpenPrClosures({ gh, repo, repository = null }) {
  const list = await readGhJson(
    gh,
    [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,closingIssuesReferences,headRefName,baseRefName,body",
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
    if (typeof entry.baseRefName !== "string") {
      throw new Error("gh pr list returned a malformed base branch");
    }
    if (typeof entry.body !== "string") {
      throw new Error("gh pr list returned a malformed body");
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
  if (list.length === 0) return { closed, pr: null, incompletePr: null, sources, repository };

  let cached = repository;
  if (cached === null) {
    const view = await readGhJson(
      gh,
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      repo,
    );
    if (!isJsonObject(view) || typeof view.nameWithOwner !== "string") {
      throw new Error("gh repo view returned no repository name");
    }
    if (!isJsonObject(view.defaultBranchRef) || typeof view.defaultBranchRef.name !== "string") {
      throw new Error("gh repo view returned no default branch name");
    }
    cached = { nameWithOwner: view.nameWithOwner, defaultBranch: view.defaultBranchRef.name };
  }
  for (const entry of list) {
    if (entry.baseRefName === cached.defaultBranch) continue;
    for (const issueNumber of closingIssueNumbers(entry.body, cached.nameWithOwner)) {
      closed.add(issueNumber);
      addSource(issueNumber, entry);
    }
  }
  let incompletePr = null;
  for (const entry of list) {
    let count = 0;
    for (let page = 1; page <= 3 && count < 250; page += 1) {
      const commits = await readGhJson(
        gh,
        [
          "api",
          `repos/${cached.nameWithOwner}/pulls/${entry.number}/commits?per_page=100&page=${page}`,
        ],
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
  return { closed, pr: firstSource, incompletePr, sources, repository: cached };
}

/**
 * Applies the eligibility checks of decision 6 in order for one issue. `claim` is the result of
 * `readClaim`. `openPrClosures` is the result of `readOpenPrClosures`, or null while that read is
 * not needed.
 * @returns {Promise<{ ok: true, title?: string } | { ok: false, reason: string, evidence: string }>}
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
    issueView = await readGhJson(
      gh,
      ["issue", "view", String(issue), "--json", "state,blockedBy,body,title"],
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

  if (!requireSpecification) return { ok: true, title: issueView.title };

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
  return { ok: true, title: issueView.title };
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
 * @returns {Promise<{ ok: true, title?: string } | { ok: false, reason: string, evidence: string }>}
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
    view = await readGhJson(
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
