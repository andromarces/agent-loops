// Requirement (#1181): every GitHub read of the CI gate is bounded by a deadline and canceled by the
// caller signal, so an aborted caller starts no read and a hung `gh` cannot stall the gate.
import { expect, it, vi } from "vite-plus/test";
import { checkCi, readRequiredChecks } from "../../src/lib/ci-gate.mjs";
import { fakeGh, HEAD, MERGE, prInfo, REVIEWED, routes, run } from "./ci-gate-helpers.mjs";

/** A `gh` that never answers until its signal aborts, then fails the way a killed child does. */
function hungGh(started) {
  return (args, cwd, { signal } = {}) =>
    new Promise((resolve) => {
      started();
      const settle = () => resolve({ status: 1, stdout: "", stderr: "gh was killed" });
      if (signal?.aborted) return settle();
      signal?.addEventListener("abort", settle, { once: true });
    });
}

const aborted = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

// Usefulness: verifies acceptance of #1181 — an aborted caller signal starts no `gh` read in
// `checkCi` and the call reports a cancel; the existing tests never pass a signal to the gate.
it("checkCi starts no read and reports a cancel when the caller signal is aborted", async () => {
  const gh = vi.fn();
  await expect(
    checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh, signal: aborted() }),
  ).rejects.toMatchObject({ isCanceled: true });
  expect(gh).not.toHaveBeenCalled();
});

// Usefulness: verifies acceptance of #1181 — a `gh` read that never returns ends `checkCi` at its
// deadline with a timeout error that callers tell from a cancel (no `isCanceled`) and from another
// read error (`timedOut` and the timeout text), where the gate had no deadline before the fix.
it("checkCi ends a hung gh read at its deadline", async () => {
  const begun = Date.now();
  await expect(
    checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh: hungGh(() => {}), timeoutMs: 50 }),
  ).rejects.toMatchObject({ timedOut: true, message: "the read timed out after 50ms" });
  expect(Date.now() - begun).toBeLessThan(5_000);
});

// Usefulness: verifies a cancel that arrives while a read hangs surfaces as a cancel, not as the
// failed-read error of the killed child, so the CLI maps it to exit 130.
it("checkCi reports a cancel when the caller aborts a hung read", async () => {
  const controller = new AbortController();
  await expect(
    checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: hungGh(() => controller.abort()),
      timeoutMs: 60_000,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies acceptance of #1181 — the status read starts no `gh` read after the caller
// aborts and reports a cancel instead of the unresolved timeout it returned before the fix.
it("readRequiredChecks starts no read and reports a cancel when the caller signal is aborted", async () => {
  const gh = vi.fn();
  await expect(
    readRequiredChecks({ pr: 42, cwd: ".", head: HEAD, clean: true, gh, signal: aborted() }),
  ).rejects.toMatchObject({ isCanceled: true });
  expect(gh).not.toHaveBeenCalled();
});

// Usefulness: verifies a cancel during a hung status read is a cancel, not "the read timed out".
it("readRequiredChecks reports a cancel when the caller aborts a hung read", async () => {
  const controller = new AbortController();
  await expect(
    readRequiredChecks({
      pr: 42,
      cwd: ".",
      head: HEAD,
      clean: true,
      gh: hungGh(() => controller.abort()),
      timeoutMs: 60_000,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies a canceled caller wins over the local refusal for a missing reviewed state,
// so a finish that is already canceled exits as a cancel, not as a gate refusal.
it("checkCi reports a cancel, not a refusal, for an aborted signal with no reviewed state", async () => {
  await expect(
    checkCi({ pr: 42, reviewed: null, cwd: ".", gh: vi.fn(), signal: aborted() }),
  ).rejects.toMatchObject({ isCanceled: true });
});

/**
 * A `gh` whose PR read names a head other than the reviewed one, so the gate stops early, and whose
 * repository read ends only when the preamble cleanup aborts it; the caller cancel arrives then.
 */
function cancelDuringSlugCleanupGh(controller) {
  return (args, cwd, { signal } = {}) => {
    if (args[0] === "pr") {
      return Promise.resolve({
        status: 0,
        stdout: JSON.stringify(prInfo({ headRefOid: MERGE })),
        stderr: "",
      });
    }
    return new Promise((resolve) => {
      signal?.addEventListener(
        "abort",
        () => {
          controller.abort();
          resolve({ status: 1, stdout: "", stderr: "gh was killed" });
        },
        { once: true },
      );
    });
  };
}

// Usefulness: verifies a cancel that arrives while the repository read is cleaned up wins over the
// refusal the gate had already decided.
it("checkCi reports a cancel, not a refusal, when the caller aborts during the slug cleanup", async () => {
  const controller = new AbortController();
  await expect(
    checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: cancelDuringSlugCleanupGh(controller),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies the same for the status read, which returned an unresolved status.
it("readRequiredChecks reports a cancel, not an unresolved status, when the caller aborts during the slug cleanup", async () => {
  const controller = new AbortController();
  await expect(
    readRequiredChecks({
      pr: 42,
      cwd: ".",
      head: HEAD,
      clean: true,
      gh: cancelDuringSlugCleanupGh(controller),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ isCanceled: true });
});

/**
 * A \`gh\` whose PR read fails at once and whose repository read ends 75 ms after its signal aborts,
 * so the slug cleanup outlasts a short deadline.
 */
function prReadDownGh() {
  return (args, cwd, { signal } = {}) => {
    if (args[0] === "pr") {
      return Promise.resolve({ status: 1, stdout: "", stderr: "PR read down" });
    }
    return new Promise((resolve) => {
      const settle = () =>
        setTimeout(() => resolve({ status: 1, stdout: "", stderr: "gh was killed" }), 75);
      if (signal?.aborted) return settle();
      signal?.addEventListener("abort", settle, { once: true });
    });
  };
}

// Usefulness: verifies an earlier read failure keeps its text and is no timeout when the slug cleanup
// that follows it reaches the deadline; the base kept the original error here.
it("checkCi keeps the first read failure when the slug cleanup outlasts the deadline", async () => {
  const error = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: prReadDownGh(),
    timeoutMs: 25,
  }).catch((err) => err);
  expect(error.message).toMatch(/PR read down/);
  expect(error.timedOut).toBeUndefined();
});

// Usefulness: verifies the same for the status read, which reported a timeout instead of the failure.
it("readRequiredChecks keeps the first read failure when the slug cleanup outlasts the deadline", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    clean: true,
    gh: prReadDownGh(),
    timeoutMs: 25,
  });
  expect(read.status).toBe("unresolved");
  expect(read.summary).toMatch(/PR read down/);
  expect(read.summary).not.toMatch(/timed out/);
});

const PASSING = () =>
  fakeGh(
    routes({
      headRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "success")],
    }),
  );

/** A passing `gh` whose replies carry the timed-out mark that a runner sets when its bound fired. */
const markedTimedOut = (inner) => async (args, cwd, options) => ({
  ...(await inner(args, cwd, options)),
  timedOut: true,
});

/** A passing `gh` that ignores its signal and answers only after `ms`, past a short deadline. */
const lateGh = (inner, ms) => async (args, cwd, options) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return inner(args, cwd, options);
};

// Usefulness: verifies the gate is fail-closed on a deadline: valid replies that a runner marks as
// timed out never pass, and the rejection is a timeout, not a cancel.
it("checkCi never passes on a reply marked as timed out", async () => {
  const error = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: markedTimedOut(PASSING()),
  }).catch((err) => err);
  expect(error).toMatchObject({ timedOut: true, message: "the read timed out after 60000ms" });
});

// Usefulness: verifies the same for a reply that arrives after the deadline expired.
it("checkCi never passes on a reply that arrives after the deadline", async () => {
  const error = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: lateGh(PASSING(), 60),
    timeoutMs: 25,
  }).catch((err) => err);
  expect(error).toMatchObject({ timedOut: true, message: "the read timed out after 25ms" });
});

// Usefulness: verifies the status read never reports a pass on a reply marked as timed out.
it("readRequiredChecks never passes on a reply marked as timed out", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    clean: true,
    gh: markedTimedOut(PASSING()),
  });
  expect(read.status).toBe("unresolved");
  expect(read.summary).toMatch(/timed out/);
});

// Usefulness: verifies the same for a reply that arrives after the deadline expired.
it("readRequiredChecks never passes on a reply that arrives after the deadline", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    clean: true,
    gh: lateGh(PASSING(), 60),
    timeoutMs: 25,
  });
  expect(read.status).toBe("unresolved");
  expect(read.summary).toMatch(/timed out/);
});
