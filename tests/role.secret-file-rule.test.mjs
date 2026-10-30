import { afterEach, expect, test } from "vite-plus/test";
import { executeRoleCommand } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newRunRepo,
  recordingAdapter,
  REPORT,
  reviewerTurn,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";

afterEach(cleanup);

const SECRET_RULE =
  "Never read, print, or quote `.env`, `.dev.vars`, or another ignored secret file. Check a configuration value by name and presence only. Keep a content search to tracked files, for example `git grep`, or `rg` without `--no-ignore` and `-u`.";

const ADAPTERS = ["claude", "codex", "agy", "opencode", "copilot"];

const squash = (text) => text.replace(/\s+/g, " ");

// Runs one worker turn and one reviewer turn, with the adapter kind named `workerKind` on the
// worker and `reviewerKind` on the reviewer, and returns the prompt that each adapter received.
async function dispatchedPrompts(workerKind, reviewerKind) {
  const repo = await newRunRepo();
  const worker = recordingAdapter([]);
  const reviewer = recordingAdapter([`${REPORT}\nVerdict: accept`]);
  const agents = { [workerKind]: worker, [reviewerKind]: reviewer };
  const overrides = INIT_OVERRIDES.map((value) =>
    value === "fake1" ? workerKind : value === "fake2" ? reviewerKind : value,
  );
  await executeRoleCommand(withRepo(dispatchArgv(overrides), repo), {
    agents,
    stdin: stdinPrompt,
  });
  await reviewerTurn(repo, agents);
  return {
    worker: squash(worker.recorded[0].prompt),
    reviewer: squash(reviewer.recorded[0].prompt),
  };
}

// Usefulness: acceptance of #1248. A child that prints a copied ignored secret file sends the value
// to the model provider, so the first worker turn carries the rule whichever adapter runs the
// worker. No other test covers the dispatched worker prompt of each adapter kind.
for (const adapter of ADAPTERS) {
  test(`the worker preamble carries the secret file rule on ${adapter}`, async () => {
    const { worker } = await dispatchedPrompts(adapter, "other");
    expect(worker).toContain(SECRET_RULE);
  });
}

// Usefulness: acceptance of #1248 for the reviewer. The reviewer prompt is rebuilt for each
// adapter kind of the reviewer role, and the worker tests above never vary that kind.
for (const adapter of ADAPTERS) {
  test(`the reviewer prompt carries the secret file rule on ${adapter}`, async () => {
    const { reviewer } = await dispatchedPrompts("other", adapter);
    expect(reviewer).toContain(SECRET_RULE);
  });
}
