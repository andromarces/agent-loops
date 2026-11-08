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
 * commit read reached the API's 250-commit page; the caller then stops launching.
 * @returns {Promise<{ closed: Set<number>, pr: number | null, incompletePr: number | null }>}
 */
export async function readOpenPrClosures({ gh, repo }) {
  const list = await readJson(
    gh,
    [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,closingIssuesReferences",
      "--limit",
      "1000",
    ],
    repo,
  );
  if (!Array.isArray(list)) throw new Error("gh pr list returned no list");
  const closed = new Set();
  const sources = new Map();
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
        if (!sources.has(reference.number)) sources.set(reference.number, entry.number);
      }
    }
  }
  if (list.length === 0) return { closed, pr: null, incompletePr: null };

  const repository = await readJson(gh, ["repo", "view", "--json", "nameWithOwner"], repo);
  if (!isJsonObject(repository) || typeof repository.nameWithOwner !== "string") {
    throw new Error("gh repo view returned no repository name");
  }
  const slug = repository.nameWithOwner;
  let incompletePr = null;
  for (const entry of list) {
    let count = 0;
    for (let page = 1; page <= 3 && count < 250; page += 1) {
      const commits = await readJson(
        gh,
        ["api", `repos/${slug}/pulls/${entry.number}/commits?per_page=100&page=${page}`],
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
          if (!sources.has(number)) sources.set(number, entry.number);
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
  return { closed, pr: first === undefined ? null : sources.get(first), incompletePr };
}

/**
 * Applies the eligibility checks of decision 6 in order for one issue. `claim` is the result of
 * `readClaim`; `openPrClosures` is the result of `readOpenPrClosures`, or null while that read is
 * not needed.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, evidence: string }>}
 */
export async function checkEligibility({ issue, gh, repo, batchId = null, claim, openPrClosures }) {
  const unverified = (detail) => ({
    ok: false,
    reason: "eligibility-unverified",
    evidence: `the read failed: ${detail}`,
  });
  let state;
  try {
    state = await readJson(gh, ["issue", "view", String(issue), "--json", "state"], repo);
  } catch (err) {
    return unverified(err.message);
  }
  if (!isJsonObject(state) || typeof state.state !== "string") {
    return unverified("the state reply named no state");
  }
  if (!isOpen(state.state)) {
    return { ok: false, reason: "closed", evidence: `the issue state is ${state.state}` };
  }

  let blockers;
  try {
    blockers = await readJson(gh, ["issue", "view", String(issue), "--json", "blockedBy"], repo);
  } catch (err) {
    return unverified(err.message);
  }
  const nodes = blockedNumbers(isJsonObject(blockers) ? blockers.blockedBy : null);
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
    return {
      ok: false,
      reason: "closed-by-open-pr",
      evidence: `pull request ${openPrClosures.pr ?? "unknown"} closes it`,
    };
  }

  let body;
  try {
    body = await readJson(gh, ["issue", "view", String(issue), "--json", "body"], repo);
  } catch (err) {
    return unverified(err.message);
  }
  if (!isJsonObject(body) || typeof body.body !== "string") {
    return unverified("the body reply named no body");
  }
  if (!hasStructuralMinimum(body.body)) {
    return {
      ok: false,
      reason: "not-specified",
      evidence: "no acceptance list, or no problem and no scope heading",
    };
  }
  return { ok: true };
}
