// Requirement (#1124): the caller cancel ends the preflight reads of `unreadableGateReason` before
// their own deadline, and the caller sees a cancel, not the warning-and-null of a failed read.
import { expect, it, vi } from "vite-plus/test";
import { unreadableGateReason } from "../../src/lib/ci-gate.mjs";
import { fakeGh, PR_VIEW, prInfo, REPO_VIEW, routes, RULES_PAGE } from "./ci-gate-helpers.mjs";

const FREE_PLAN_403 =
  "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

/** A `gh` that never answers until its signal aborts, then fails the way a killed child does. */
function hungGh(started) {
  return (args, cwd, { signal } = {}) =>
    new Promise((resolve) => {
      started();
      const settle = () => resolve({ status: 1, stdout: "", stderr: "gh was canceled" });
      if (signal?.aborted) return settle();
      signal?.addEventListener("abort", settle, { once: true });
    });
}

// Usefulness: verifies acceptance of #1124 — an aborted caller signal ends a hung read long before
// the 60 s deadline, and the rejection is a cancel that the CLI maps to exit 130, not a null reason.
it("a canceled caller signal ends a hung preflight read as a cancel before the deadline", async () => {
  const controller = new AbortController();
  const started = vi.fn(() => controller.abort());
  const begun = Date.now();
  await expect(
    unreadableGateReason({
      pr: 42,
      cwd: ".",
      gh: hungGh(started),
      timeoutMs: 60_000,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ isCanceled: true });
  expect(Date.now() - begun).toBeLessThan(5_000);
});

// Usefulness: verifies a run with no cancel keeps its bound — a hung read still ends at the
// deadline with a null reason, so the cancel path does not replace the timeout path.
it("a hung preflight read with no cancel still ends at the deadline with a null reason", async () => {
  const reason = await unreadableGateReason({
    pr: 42,
    cwd: ".",
    gh: hungGh(() => {}),
    timeoutMs: 50,
    signal: new AbortController().signal,
  });
  expect(reason).toBeNull();
});

/** A `gh` double over `table` that records every call, so a test sees which reads ran. */
function recordingGh(table) {
  const calls = [];
  const gh = fakeGh(table);
  return { calls, gh: (args, ...rest) => (calls.push(args.join(" ")), gh(args, ...rest)) };
}

// Usefulness: verifies #1182 — the preflight starts no `gh pr checks`, which its answer never
// depends on, when the ruleset read settles something.
it("a readable ruleset read finishes the preflight with no pr checks", async () => {
  const { calls, gh } = recordingGh(routes());
  expect(await unreadableGateReason({ pr: 42, cwd: ".", gh })).toBeNull();
  expect(calls.some((call) => call.startsWith("pr checks"))).toBe(false);
});

const UNREADABLE_RULESETS = [
  [PR_VIEW, prInfo()],
  [REPO_VIEW, "andromarces/agent-loops"],
  [RULES_PAGE, `stderr: ${FREE_PLAN_403}`],
];
const PROTECTION = "api repos/andromarces/agent-loops/branches/main/protection";

// Usefulness: verifies #1182 keeps the one refusal the preflight exists for, an unreadable ruleset
// source, and that the one protection read it makes then starts no `gh pr checks`.
it("an unreadable ruleset source is still refused, with no pr checks", async () => {
  const { calls, gh } = recordingGh([...UNREADABLE_RULESETS, [PROTECTION, null]]);
  expect(await unreadableGateReason({ pr: 42, cwd: ".", gh })).toMatch(/repository rulesets/);
  expect(calls.some((call) => call.startsWith("pr checks"))).toBe(false);
});

// Usefulness: verifies #1182 changes no result — an unreadable ruleset source beside a protection read
// that fails (HTTP 502) is no refusal, as before: the failed read leaves the gate to read at finish.
it("an unreadable ruleset source beside a failed protection read is no refusal", async () => {
  const gh = fakeGh([...UNREADABLE_RULESETS, [PROTECTION, "stderr: gh: Bad Gateway (HTTP 502)"]]);
  expect(await unreadableGateReason({ pr: 42, cwd: ".", gh })).toBeNull();
});

/** A `gh` over `table` that answers each call in `delays` (keyed by the route) after that many ms. */
function slowGh(table, delays) {
  const gh = fakeGh(table);
  return async (args, ...rest) => {
    const key = args.join(" ");
    const wait = Object.entries(delays).find(([route]) => key.startsWith(route))?.[1] ?? 0;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return gh(args, ...rest);
  };
}

// Usefulness: verifies #1182 changes no result within the same deadline — the ruleset and protection
// reads run together, so two replies that each fit the deadline refuse though their sum does not.
it("an unreadable ruleset source beside a slow protection read is refused within the deadline", async () => {
  const gh = slowGh([...UNREADABLE_RULESETS, [PROTECTION, null]], {
    "api repos/andromarces/agent-loops/rules": 400,
    [PROTECTION]: 400,
  });
  expect(await unreadableGateReason({ pr: 42, cwd: ".", gh, timeoutMs: 600 })).toMatch(
    /repository rulesets/,
  );
});

// Usefulness: verifies #1182 — a ruleset read that settles something ends the preflight at once, so a
// protection read that does not answer is canceled and never holds the declaration open.
it("a settled ruleset read cancels a protection read that does not answer", async () => {
  const hung = hungGh(() => {});
  const gh = (args, cwd, options) =>
    args.join(" ") === PROTECTION ? hung(args, cwd, options) : fakeGh(routes())(args, cwd, options);
  const begun = Date.now();
  expect(await unreadableGateReason({ pr: 42, cwd: ".", gh, timeoutMs: 60_000 })).toBeNull();
  expect(Date.now() - begun).toBeLessThan(5_000);
});
