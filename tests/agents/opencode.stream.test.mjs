import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { runOpenCode } from "../../src/agents/opencode.mjs";
import { exec } from "../../src/lib/exec.mjs";
import {} from "../../src/lib/log.mjs";
import { parseReportBlock, parseVerdict } from "../../src/lib/report.mjs";
import { executeRoleCommand, parseRoleArgs } from "../../src/role.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { textEvent, trackDispatchPaths } from "./opencode-helpers.mjs";

vi.mock("../../src/lib/exec.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  exec: vi.fn(),
}));

// The dispatch path logs through several entry points, so the mock names them all
// rather than leaving the role and snapshot modules with undefined imports.
vi.mock("../../src/lib/log.mjs", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logInfoFull: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  setVerbose: vi.fn(),
  setLogsToStderr: vi.fn(),
}));

/** Runs root and temp repo for the dispatch test, removed after it. */

const dispatchPaths = trackDispatchPaths();

const CLOSING_BLOCK = [
  "Conclusion: PR #314 fixes the part join.",
  "Why: the narration and the block arrived as two text parts.",
  "Blockers: none",
  "Checks: pnpm test",
  "Notes: none",
  "Deferred: none",
].join("\n");

/** Streams `events` (JSON lines) as an opencode turn and returns the response text. */

async function runWithEvents(...events) {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: events.join("\n"), stderr: "" });
  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  return runOpenCode(state, "oc prompt", { cwd: "/dir" });
}

/** Streams `text` as the response of an opencode turn and returns the response text. */

async function runWithText(...text) {
  return runWithEvents(...text.map((part) => textEvent(part)));
}

const BLOCK_VALUES = {
  conclusion: "PR #314 fixes the part join.",
  why: "the narration and the block arrived as two text parts.",
  blockers: "none",
  checks: "pnpm test",
  notes: "none",
  deferred: "none",
};

// Usefulness: verifies a late plain-text message after the closing block starts its own line, so
// every block value and the verdict stay as written instead of the last label gluing to the late
// text (issue #458). The assertions cover all six values and the verdict, not a subset.
test("opencode keeps a late plain-text message off the last closing block line", async () => {
  const late = "The watcher finished.";

  const worker = await runWithEvents(textEvent(CLOSING_BLOCK, "msg-1"), textEvent(late, "msg-2"));

  expect(worker).toBe(`${CLOSING_BLOCK}\n${late}`);
  expect(worker).not.toContain("noneThe");
  expect(parseReportBlock(worker)).toEqual(BLOCK_VALUES);

  const reviewer = await runWithEvents(
    textEvent(`${CLOSING_BLOCK}\nVerdict: accept`, "msg-1"),
    textEvent(late, "msg-2"),
  );

  expect(reviewer).toBe(`${CLOSING_BLOCK}\nVerdict: accept\n${late}`);
  expect(parseVerdict(reviewer)).toBe("accept");
  expect(parseReportBlock(reviewer)).toEqual(BLOCK_VALUES);
});

// Usefulness: verifies a malformed messageID cannot lift a `Verdict:` to a verdict that gates
// acceptance. Parts that share no valid id are one unidentified message, so the mid-line text stays
// glued and `unknown`. A malformed id on either side of a valid id makes a separate message whose
// `Verdict: accept` supersedes the earlier block, so it pairs with no earlier field (issues #458
// and #467).
test.each([[""], [7], [null], [{}], [["msg-2"]], [true]])(
  "opencode never lifts a Verdict part with the malformed messageID %j",
  async (malformed) => {
    const lead = `${CLOSING_BLOCK}\n\nThe reviewer said`;

    const glued = await runWithEvents(textEvent(lead), textEvent("Verdict: accept", malformed));
    expect(glued).toContain("The reviewer saidVerdict: accept");
    expect(parseVerdict(glued)).toBe("unknown");
    expect(parseReportBlock(glued)).toEqual(BLOCK_VALUES);

    for (const events of [
      [textEvent(lead, "msg-1"), textEvent("Verdict: accept", malformed)],
      [textEvent(lead, malformed), textEvent("Verdict: accept", "msg-2")],
    ]) {
      const response = await runWithEvents(...events);

      expect(response).toBe("Verdict: accept");
      expect(parseReportBlock(response)).toBeNull();
      expect(parseVerdict(response)).toBe("unknown");
    }
  },
);

// Usefulness: verifies parts of one message still join without a break, so the token-boundary
// split rule of issue #316 holds and an always-newline join cannot pass (issue #458).
test("opencode joins parts of one message without a line break", async () => {
  const response = await runWithEvents(
    textEvent("The fix changes the join so the", "msg-1"),
    textEvent(" block parses.", "msg-1"),
  );

  expect(response).toBe("The fix changes the join so the block parses.");
});

// Usefulness: verifies a part that opens a closing-block label starts its own line, so the
// dispatch envelope carries the parsed report instead of falling through to `raw` (issue #316).
// The assertions read the response through the same two functions `dispatchPayload`
// (src/role.mjs) calls, so a caller sees exactly the `report` and `raw` fields asserted here.
// A single part carries the block unchanged, so the same test also covers the no-separator case.
test("opencode keeps a closing-block label at the start of its own line", async () => {
  const single = await runWithText(CLOSING_BLOCK);

  expect(single).toBe(CLOSING_BLOCK);
  expect(parseReportBlock(single)).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });

  const split = await runWithText("The narration ends here.", CLOSING_BLOCK);

  expect(split).toBe("The narration ends here.\n" + CLOSING_BLOCK);
  expect(parseReportBlock(split)).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
});

// Usefulness: verifies a part that continues a sentence gains no line break, so a mid-sentence
// split keeps the prose intact, the envelope still carries the parsed report, and an unconditional
// newline join cannot pass (issue #316).
test("opencode joins a mid-sentence split without a line break", async () => {
  const response = await runWithText(
    "The fix changes the join so the",
    " block parses.\n" + CLOSING_BLOCK,
  );

  expect(response).toBe("The fix changes the join so the block parses.\n" + CLOSING_BLOCK);
  expect(parseReportBlock(response)).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
});

// Usefulness: verifies the caller-visible envelope for a two-event opencode stream, so the join is
// covered where a caller reads it. A narration part then the part that opens the closing block must
// reach the caller as a parsed `report` with no `raw`, which is the field the parent loop reads for
// the structured fields. The join tests above cover the string; this one covers the seam (issue #316).
test("an opencode stream split before the closing block reaches the dispatch envelope", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "opencode-test-runs-"));
  dispatchPaths.push(runsRoot);
  const repo = await createTempRepo();
  dispatchPaths.push(repo);
  process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;

  const init = parseRoleArgs([
    "dispatch",
    "--role",
    "worker",
    "--cwd",
    repo,
    "--task",
    "Fix the part join.",
    "--parent-session",
    "sess-parent-1",
    "--worker",
    "opencode",
    "--reviewer",
    "opencode",
  ]);
  const stdin = async () => "continue working";
  vi.mocked(exec).mockResolvedValue({ stdout: "", stderr: "" });
  await executeRoleCommand(init, { agents: { opencode: { run: runOpenCode } }, stdin });

  vi.mocked(exec).mockResolvedValue({
    stdout: [textEvent("The narration ends here."), textEvent(CLOSING_BLOCK)].join("\n"),
    stderr: "",
  });
  const result = await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo]),
    { agents: { opencode: { run: runOpenCode } }, stdin },
  );

  expect(result.exitCode).toBe(0);
  expect(result.payload.status).toBe("ok");
  expect(result.payload.report).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
  expect(result.payload.raw).toBeUndefined();
});

// Usefulness: verifies a part boundary inside a sentence does not promote mid-line text to a
// column-0 `Verdict:` label, so the dispatch envelope keeps `verdict: unknown` where the joined
// string holds the word mid-line (issue #316). Lifting it would invent a verdict the model never
// wrote as a label, and a verdict gates acceptance. The report still parses, so the probe covers
// both envelope fields in one turn.
test("opencode keeps a mid-line Verdict part out of the closing block", async () => {
  const response = await runWithText(CLOSING_BLOCK + "\n\nThe reviewer said", "Verdict: accept");

  expect(parseVerdict(response)).toBe("unknown");
  expect(response).toContain("The reviewer saidVerdict: accept");
  expect(parseReportBlock(response)).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
});

// Usefulness: verifies a timed-out first turn keeps the session id its partial stream printed, so
// the next turn resumes it (issue #360). A resumed turn keeps its stored id.
test("opencode keeps the session id from a failed first turn", async () => {
  const stdout = JSON.stringify({ type: "step_start", sessionID: "ses-failed", part: {} });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("opencode timed out."), { stdout, stderr: "", timedOut: true }),
  );
  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  await expect(runOpenCode(state, "p", { cwd: "/dir" })).rejects.toThrow("timed out");
  expect(state.sessionId).toBe("ses-failed");

  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("opencode exited."), { stdout, stderr: "", exitCode: 1 }),
  );
  const resumed = { kind: "opencode", sessionId: "ses-stored", model: null, effort: null };
  await expect(runOpenCode(resumed, "p", { cwd: "/dir" })).rejects.toThrow();
  expect(resumed.sessionId).toBe("ses-stored");
});

// Usefulness: verifies a first turn that reports a session and then fails response validation keeps
// the session id, as issue #360 requires of every adapter error path.
test("opencode keeps the session id when a first turn fails response validation", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ type: "step_start", sessionID: "ses-validated", part: {} }),
    stderr: "",
  });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  await expect(runOpenCode(state, "p", { cwd: "/dir" })).rejects.toThrow("response text");
  expect(state.sessionId).toBe("ses-validated");
});

// Usefulness: verifies a successful result whose session id is truthy but not a string, such as a
// number or an object, fails the turn with a clear error instead of returning success with no
// stored id. A first turn keeps no id, and a resumed turn keeps its stored id (issue #360).
test.each([
  ["a number", 42],
  ["an object", { id: "x" }],
])("opencode rejects %s as the reported session id", async (_name, id) => {
  const stdout = [
    { type: "step_start", sessionID: id, part: {} },
    { type: "text", sessionID: id, part: { text: "ok" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const first = { kind: "opencode", sessionId: null, model: null, effort: null };
  await expect(runOpenCode(first, "p", { cwd: "/dir" })).rejects.toThrow(
    "opencode did not return a session ID.",
  );
  expect(first.sessionId).toBeNull();

  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const resumed = { kind: "opencode", sessionId: "stored", model: null, effort: null };
  await expect(runOpenCode(resumed, "p", { cwd: "/dir" })).rejects.toThrow(
    "opencode did not return a session ID.",
  );
  expect(resumed.sessionId).toBe("stored");
});

// Usefulness: verifies the adapter selects the first truthy id (an empty id is skipped), then validates
// that selected id, so a later valid id never rescues an invalid or mismatched selected one. A
// resumed turn keeps its stored id on every failure (issue #360).
test.each([
  ["invalid then valid, first turn", [42, "good"], null, "ERR_ID"],
  ["empty then valid, first turn", ["", "good"], null, "good"],
  ["valid then different valid, first turn", ["a", "b"], null, "a"],
  ["invalid then stored, resumed turn", [42, "stored"], "stored", "ERR_ID"],
  ["different then stored, resumed turn", ["other", "stored"], "stored", "ERR_MISMATCH"],
  ["stored then different, resumed turn", ["stored", "other"], "stored", "stored"],
  ["empty then stored, resumed turn", ["", "stored"], "stored", "stored"],
])("opencode selects then validates the id: %s", async (_name, ids, requested, expected) => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      ...ids.map((id) => ({ type: "step_start", sessionID: id, part: {} })),
      { type: "text", part: { text: "ok" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
    stderr: "",
  });
  const state = { kind: "opencode", sessionId: requested, model: null, effort: null };
  const call = runOpenCode(state, "p", { cwd: "/dir" });

  if (expected === "ERR_ID" || expected === "ERR_MISMATCH") {
    await expect(call).rejects.toThrow(
      expected === "ERR_ID"
        ? "opencode did not return a session ID."
        : "opencode did not resume the expected session.",
    );
    expect(state.sessionId).toBe(requested);
  } else {
    await expect(call).resolves.toBe("ok");
    expect(state.sessionId).toBe(expected);
  }
});

// Decision (issue #467): the last closing block governs, and it governs alone. A message that holds
// a closing block attempt supersedes every earlier message that holds one, as the Codex and Copilot
// adapters select it (lastClosingMessage, src/agents/shared.mjs). A late message never combines
// with the fields of the earlier block, so a late bare `Verdict: accept` cannot pair with the
// earlier `Checks` line to satisfy the `--require-accept` gate.
const REJECTED_BLOCK = CLOSING_BLOCK.replace("Blockers: none", "Blockers: b1").replace(
  "Deferred: none",
  "Verdict: reject",
);

const LATE_FULL_BLOCK = [
  "Conclusion: late",
  "Why: late reason",
  "Blockers: late blocker",
  "Checks: late check",
  "Verdict: accept",
].join("\n");

// Usefulness: verifies a late bare `Verdict: accept` governs alone in both line-break shapes of the
// earlier message: the earlier fields, including `Checks`, do not carry over, so the report is
// unparseable and the verdict is `unknown` as the Codex selection gives (issue #467, rows 1-2).
test.each([
  ["no trailing newline", REJECTED_BLOCK],
  ["a trailing newline", `${REJECTED_BLOCK}\n`],
])(
  "opencode drops the earlier block fields for a late bare Verdict after %s",
  async (_name, first) => {
    const response = await runWithEvents(
      textEvent(first, "msg-1"),
      textEvent("Verdict: accept", "msg-2"),
    );

    expect(response).toBe("Verdict: accept");
    expect(parseReportBlock(response)).toBeNull();
    expect(parseVerdict(response)).toBe("unknown");
  },
);

// Usefulness: verifies a late partial block governs alone: no report fields, and the verdict of the
// late message only (issue #467, row 3).
test("opencode reports a late partial block as unparseable without the earlier fields", async () => {
  const response = await runWithEvents(
    textEvent(REJECTED_BLOCK, "msg-1"),
    textEvent("Conclusion: late\nVerdict: accept", "msg-2"),
  );

  expect(parseReportBlock(response)).toBeNull();
  expect(parseVerdict(response)).toBe("accept");
});

// Usefulness: verifies a late `Blockers: none` does not edit the earlier block: it governs alone, so
// the earlier `Blockers: b1`, `Checks`, and verdict do not survive in a combined report (row 4).
test("opencode does not merge a late Blockers line into the earlier block", async () => {
  const response = await runWithEvents(
    textEvent(REJECTED_BLOCK, "msg-1"),
    textEvent("Blockers: none", "msg-2"),
  );

  expect(parseReportBlock(response)).toBeNull();
  expect(parseVerdict(response)).toBe("unknown");
});

// Usefulness: verifies a later complete block replaces the earlier one in full, the only way a late
// message changes the report (issue #467).
test("opencode lets a later complete block replace the earlier block", async () => {
  const response = await runWithEvents(
    textEvent(REJECTED_BLOCK, "msg-1"),
    textEvent(LATE_FULL_BLOCK, "msg-2"),
  );

  expect(response).toBe(LATE_FULL_BLOCK);
  expect(parseReportBlock(response)).toMatchObject({
    blockers: "late blocker",
    checks: "late check",
  });
  expect(parseVerdict(response)).toBe("accept");
});

// Usefulness: verifies narration before the block and plain prose after it stay in the response,
// so only a superseded closing block attempt is dropped (issue #467).
test("opencode keeps narration and late prose around the governing block", async () => {
  const response = await runWithEvents(
    textEvent("Working on it.", "msg-1"),
    textEvent(REJECTED_BLOCK, "msg-2"),
    textEvent("The watcher finished.", "msg-3"),
  );

  expect(response).toBe(`Working on it.\n${REJECTED_BLOCK}\nThe watcher finished.`);
  expect(parseVerdict(response)).toBe("reject");
});

// Usefulness: verifies parts of one message stay one message when another message comes between
// them (A/B/A order): the only complete block, split across A's parts, is not dropped as superseded
// by its own later part, so its report and verdict survive (issue #467).
test("opencode keeps the only complete block of a message whose parts another message interrupts", async () => {
  const [head, tail] = [REJECTED_BLOCK.slice(0, 60), REJECTED_BLOCK.slice(60)];
  const response = await runWithEvents(
    textEvent(head, "msg-a"),
    textEvent("A side note.", "msg-b"),
    textEvent(tail, "msg-a"),
  );

  expect(response).toBe(`${REJECTED_BLOCK}\nA side note.`);
  expect(parseVerdict(response)).toBe("reject");
  expect(parseReportBlock(response)).toMatchObject({ blockers: "b1", checks: "pnpm test" });
});

const ACCEPTED_BLOCK = `${CLOSING_BLOCK}\nVerdict: accept`;

const INTERLEAVED = "opencode returned closing block attempts from interleaved messages.";

// Usefulness: verifies the reviewer's stream fails closed: unidentified narration comes first, A holds
// a full accept block with `Checks`, and a later unidentified part holds a reject block. The two
// attempt-holding messages interleave in the stream, so no block can be said to govern and the
// turn errors instead of returning the accept (issue #467).
test("opencode refuses a stream whose unidentified block interleaves an identified block", async () => {
  await expect(
    runWithEvents(
      textEvent("Working on it."),
      textEvent(ACCEPTED_BLOCK, "msg-a"),
      textEvent(`${REJECTED_BLOCK}\n`),
    ),
  ).rejects.toThrow(INTERLEAVED);
});

// Usefulness: verifies an invalid-id part cannot pull A's verdict out of A: A's parts surround B's
// reject block, so both messages hold an attempt and interleave. The turn errors, so no accept can
// pair with B's `Checks` line (issue #467).
test("opencode refuses two blocks whose messages interleave across an invalid-id part", async () => {
  await expect(
    runWithEvents(
      textEvent("Working on it.", "msg-a"),
      textEvent(`${REJECTED_BLOCK}\n`, "msg-b"),
      textEvent("", 7),
      textEvent("Verdict: accept", "msg-a"),
    ),
  ).rejects.toThrow(INTERLEAVED);
});

// Usefulness: verifies the error of an interleaved stream carries the assistant text of every
// message, joined as an uninterleaved stream would be, so the orchestrator and the user can read
// what the model wrote while no accept can come from the turn (issue #493).
test("opencode keeps the joined assistant text on the interleaved-stream error", async () => {
  const error = await runWithEvents(
    textEvent("Working on it.", "msg-a"),
    textEvent(`${REJECTED_BLOCK}\n`, "msg-b"),
    textEvent("Verdict: accept", "msg-a"),
  ).catch((err) => err);

  expect(error).toBeInstanceOf(Error);
  expect(error.message.split("\n")[0]).toBe(INTERLEAVED);
  expect(error.message).toContain(`Working on it.Verdict: accept\n${REJECTED_BLOCK}`);
});

// Usefulness: verifies the error of an interleaved stream has a fixed upper size however long the
// model text is, keeps the cause on the first line and the tail of the text, and marks the cut, so
// the envelope and the state file cannot grow without a limit (issue #510).
test("opencode bounds and marks the joined text on the interleaved-stream error", async () => {
  const filler = "x".repeat(150_000);
  const run = (text) =>
    runWithEvents(
      textEvent(text, "msg-a"),
      textEvent(`${REJECTED_BLOCK}\n`, "msg-b"),
      textEvent("Verdict: accept", "msg-a"),
    ).catch((err) => err);

  const small = await run("Working on it.");
  const large = await run(filler);
  const larger = await run(filler.repeat(3));

  expect(large.message.split("\n")[0]).toBe(INTERLEAVED);
  expect(large.message.length).toBeLessThan(10_000);
  expect(larger.message.length).toBe(large.message.length);
  expect(large.message.split("\n")[1]).toMatch(/cut/i);
  expect(large.message.trimEnd().endsWith(REJECTED_BLOCK.trimEnd())).toBe(true);
  expect(small.message).not.toMatch(/cut/i);
});

// Usefulness: verifies the cut never leaves a fragment of a secret-named environment value: a cut
// that lands inside the value would leave a suffix that exact-value redaction cannot match, so the
// bound must not expose what redaction would have hidden (issue #510).
test("opencode leaves no secret fragment on a cut interleaved-stream error", async () => {
  const secret = "s3cr3t-value-0123456789-abcdefghijklmnopqrstuvwxyz";
  vi.stubEnv("OPENCODE_TEST_TOKEN", secret);
  try {
    const after = "Verdict: accept".length + 1 + `${REJECTED_BLOCK}\n`.length;
    const padding = "x".repeat(3980 - after);
    const error = await runWithEvents(
      textEvent(`${"p".repeat(10_000)}${secret}${padding}`, "msg-a"),
      textEvent(`${REJECTED_BLOCK}\n`, "msg-b"),
      textEvent("Verdict: accept", "msg-a"),
    ).catch((err) => err);

    expect(error.message.split("\n")[1]).toMatch(/cut/i);
    expect(error.message).not.toContain(secret.slice(-12));
  } finally {
    vi.unstubAllEnvs();
  }
});

// Usefulness: verifies the cut never splits a UTF-16 surrogate pair, so the error text stays
// well-formed Unicode whichever side of a code point the limit lands on (issue #510).
test.each(["", "x"])(
  "opencode cuts the interleaved-stream error on a code point boundary %j",
  async (trail) => {
    const error = await runWithEvents(
      textEvent(`${"😀".repeat(5000)}${trail}`, "msg-a"),
      textEvent(`${REJECTED_BLOCK}\n`, "msg-b"),
      textEvent("Verdict: accept", "msg-a"),
    ).catch((err) => err);

    expect(error.message.split("\n")[1]).toMatch(/cut/i);
    expect(error.message).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  },
);

// Usefulness: verifies the unidentified-part error has a fixed upper size however long the model
// text is, keeps the cause on the first line and the tail of the text, and marks the cut, so the
// envelope and the state file cannot grow without a limit (issue #529). The turn still errors, so
// no accept can come from it (issue #509).
test("opencode bounds and marks the joined text on the unidentified-part error", async () => {
  const run = (text) =>
    runWithEvents(textEvent(`${text}\n${CLOSING_BLOCK}\n`), textEvent("Verdict: accept")).catch(
      (err) => err,
    );

  const small = await run("Working on it.");
  const large = await run("x".repeat(150_000));
  const larger = await run("x".repeat(450_000));

  expect(large.message.split("\n")[0]).toBe(UNIDENTIFIED_REFUSAL);
  expect(large.message.length).toBeLessThan(10_000);
  expect(larger.message.length).toBe(large.message.length);
  expect(large.message.split("\n")[1]).toMatch(/cut/i);
  expect(large.message.trimEnd().endsWith("Verdict: accept")).toBe(true);
  expect(small.message).toContain("Working on it.");
  expect(small.message).not.toMatch(/cut/i);
});

// Usefulness: verifies the cut never leaves a fragment of a secret-named environment value on the
// unidentified-part error, as on the interleaved error (issue #529).
test("opencode leaves no secret fragment on a cut unidentified-part error", async () => {
  const secret = "s3cr3t-value-0123456789-abcdefghijklmnopqrstuvwxyz";
  vi.stubEnv("OPENCODE_TEST_TOKEN", secret);
  try {
    const tail = `\n${CLOSING_BLOCK}\n`;
    const after = tail.length + "Verdict: accept".length;
    const padding = "x".repeat(3980 - after);
    const error = await runWithEvents(
      textEvent(`${"p".repeat(10_000)}${secret}${padding}${tail}`),
      textEvent("Verdict: accept"),
    ).catch((err) => err);

    expect(error.message.split("\n")[1]).toMatch(/cut/i);
    expect(error.message).not.toContain(secret.slice(-12));
  } finally {
    vi.unstubAllEnvs();
  }
});

// Usefulness: verifies one block split across A's parts, with another message's block between them,
// is ambiguous and errors rather than letting either block govern (issue #467).
test("opencode refuses a block split across parts that another block interrupts", async () => {
  await expect(
    runWithEvents(
      textEvent(REJECTED_BLOCK.slice(0, 60), "msg-a"),
      textEvent(LATE_FULL_BLOCK, "msg-b"),
      textEvent(REJECTED_BLOCK.slice(60), "msg-a"),
    ),
  ).rejects.toThrow(INTERLEAVED);
});

// Usefulness: verifies a new valid id after an invalid-id part still starts its own message: its
// `Verdict: accept` supersedes the earlier block instead of joining it and pairing with the earlier
// `Checks` line, so the report fails closed (issue #467).
test("opencode does not bridge a new valid-id message into the block before an invalid-id part", async () => {
  const response = await runWithEvents(
    textEvent(`${REJECTED_BLOCK}\n`, "msg-b"),
    textEvent("", 7),
    textEvent("Verdict: accept", "msg-c"),
  );

  expect(response).toBe("Verdict: accept");
  expect(parseReportBlock(response)).toBeNull();
  expect(parseVerdict(response)).toBe("unknown");
});

// Usefulness: verifies a part with no valid id never joins a message that has one: a late
// `Verdict: accept` without an id supersedes the earlier block instead of landing on its own line
// inside it and pairing with its `Checks` line (issue #467).
test.each([[undefined], [""], [null]])(
  "opencode keeps a part with messageID %j out of the block message",
  async (messageID) => {
    const response = await runWithEvents(
      textEvent(`${REJECTED_BLOCK}\n`, "msg-b"),
      textEvent("Verdict: accept", messageID),
    );

    expect(response).toBe("Verdict: accept");
    expect(parseReportBlock(response)).toBeNull();
    expect(parseVerdict(response)).toBe("unknown");
  },
);

// Usefulness: verifies the attempt test reads the whole late message, because a `Verdict:` label can
// span parts. A split label, an empty first part, and an indented label all hold an attempt, so each
// supersedes the earlier block and governs alone (issue #467).
test.each([
  ["a label split across parts", ["Ver", "dict: accept"]],
  ["an empty first part", ["", "Verdict: accept"]],
  ["leading whitespace parts", [" ", "\t", "Verdict: accept"]],
])("opencode reads a late message of %s as one superseding message", async (_name, late) => {
  const response = await runWithEvents(
    textEvent(REJECTED_BLOCK, "msg-1"),
    ...late.map((part) => textEvent(part, "msg-2")),
  );

  expect(response).toBe(late.join("").trim());
  expect(parseReportBlock(response)).toBeNull();
});

// Usefulness: verifies the reviewer-only Codex sandbox input changes no opencode invocation, so the
// opt-in reaches Codex alone (issue #421).
test("opencode invocation is identical with the reviewer sandbox input on and off", async () => {
  vi.mocked(exec).mockClear();
  const reply = { stdout: textEvent("ok"), stderr: "" };
  vi.mocked(exec).mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
  const turn = (extra) =>
    runOpenCode({ kind: "opencode", sessionId: null, model: null, effort: null }, "p", {
      cwd: "/dir",
      readOnly: true,
      ...extra,
    });

  await turn({});
  await turn({ sandbox: "workspace-write" });

  const [off, on] = vi.mocked(exec).mock.calls;
  expect(on).toEqual(off);
});

const UNIDENTIFIED_REFUSAL = "opencode returned a closing block that spans unidentified parts.";

// Usefulness: verifies the shared unidentified group fails closed: a `Verdict: accept` part on its
// own line cannot pair with the `Checks` line of an earlier unidentified part. The turn errors with
// the assistant text, so no accept comes from it and the text stays readable (issue #509).
test("opencode refuses an accept that spans unidentified parts", async () => {
  const error = await runWithEvents(
    textEvent(`${CLOSING_BLOCK}\n`),
    textEvent("Verdict: accept"),
  ).catch((err) => err);

  expect(error).toBeInstanceOf(Error);
  expect(error.message.split("\n")[0]).toBe(UNIDENTIFIED_REFUSAL);
  expect(error.message).toContain("Verdict: accept");
  expect(error.message).toContain("Checks: pnpm test");
});

// Usefulness: verifies a block that sits whole in one unidentified part still parses as accept, so
// the fail-closed rule of issue #509 does not reject an ordinary no-id stream.
test("opencode accepts a whole block held by one unidentified part", async () => {
  const response = await runWithEvents(
    textEvent("Working on it."),
    textEvent(`${ACCEPTED_BLOCK}\n`),
  );

  expect(parseVerdict(response)).toBe("accept");
});

// Usefulness: verifies the unidentified fail-closed rule holds however the lines split: a label cut
// across parts, so no single part holds an attempt for the split label, still ends as an error
// instead of an accept (issue #509, reviewer probe 1).
test.each([
  [[`${CLOSING_BLOCK}\nVer`, "dict: accept"]],
  [["Conclusion: c\nWhy: w\nBlockers: none\nChe", "cks: pnpm test\nVerdict: accept"]],
  [[`${CLOSING_BLOCK}\nVerdict: acc`, "ept"]],
])("opencode refuses an accept whose labels split across unidentified parts %j", async (parts) => {
  const error = await runWithEvents(...parts.map((part) => textEvent(part))).catch((err) => err);

  expect(error).toBeInstanceOf(Error);
  expect(error.message.split("\n")[0]).toBe(UNIDENTIFIED_REFUSAL);
});

// Usefulness: verifies a complete block inside one unidentified part parses as accept when an earlier
// part only mentions a label in prose, so the fail-closed rule does not reject what main accepts
// (issue #509, reviewer probe 2).
test.each([["Remember that the Verdict: line is required."], ["Checks: will follow below."]])(
  "opencode accepts a whole unidentified block after prose that mentions a label: %s",
  async (prose) => {
    const response = await runWithEvents(textEvent(prose), textEvent(ACCEPTED_BLOCK));

    expect(parseVerdict(response)).toBe("accept");
    expect(parseReportBlock(response)).toEqual(BLOCK_VALUES);
  },
);

// Usefulness: verifies a line terminator alone never makes a later unidentified part count as block
// content: a whole accept block in one part still parses as accept when the next part starts with
// CRLF, LF, or CR, as it does on main (issue #509, reviewer probe 3).
test.each([["\r\nThe watcher finished.\r\n"], ["\nThe watcher finished."], ["\r\n"]])(
  "opencode accepts a whole unidentified block before a part that starts with a line terminator %j",
  async (late) => {
    const response = await runWithEvents(textEvent(ACCEPTED_BLOCK), textEvent(late));

    expect(parseVerdict(response)).toBe("accept");
    expect(parseReportBlock(response)).toEqual(BLOCK_VALUES);
  },
);

// Usefulness: verifies a bare CR part is no new error: it glues to the Verdict line and the verdict
// reads `unknown` as on main, never accept (issue #509, reviewer probe 3).
test("opencode reads a whole unidentified block before a bare CR part as unknown", async () => {
  const response = await runWithEvents(textEvent(ACCEPTED_BLOCK), textEvent("\rThe watcher."));

  expect(parseVerdict(response)).toBe("unknown");
});

// Usefulness: verifies a Verdict value cut across parts still fails closed when a CRLF follows, so
// the terminator fix of issue #509 does not reopen the split-label bypass.
test("opencode refuses a Verdict value split across parts before a CRLF", async () => {
  const error = await runWithEvents(
    textEvent(`${CLOSING_BLOCK}\nVerdict: acc`),
    textEvent("ept\r\n"),
  ).catch((err) => err);

  expect(error).toBeInstanceOf(Error);
  expect(error.message.split("\n")[0]).toBe(UNIDENTIFIED_REFUSAL);
});
