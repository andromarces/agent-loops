import { afterEach, expect, test } from "vite-plus/test";
import {
  cleanup,
  INIT_OVERRIDES,
  newRunRepo,
  recordingAdapter,
  REPORT,
  reviewerTurn,
  withRepo,
  dispatchArgv,
  stdinPrompt,
} from "./role-helpers.mjs";
import { executeRoleCommand } from "../src/role.mjs";

afterEach(cleanup);

const SECRET_RULE =
  "Never read, print, or quote `.env`, `.dev.vars`, or another ignored secret file. Check a configuration value by name and presence only. Keep a content search to tracked files, for example `git grep`, or `rg` without `--no-ignore` and `-u`.";

const ADAPTERS = ["claude", "codex", "agy", "opencode", "copilot"];

// Usefulness: acceptance of #1248. A child that prints a copied ignored secret file sends the value
// to the model provider, so the first worker turn and every reviewer turn carry the rule whichever
// adapter runs the role. No other test covers the dispatched prompt of each adapter kind.
for (const adapter of ADAPTERS) {
  test(`the worker preamble and the reviewer prompt carry the secret file rule on ${adapter}`, async () => {
    const repo = await newRunRepo();
    const worker = recordingAdapter([]);
    const reviewer = recordingAdapter([`${REPORT}\nVerdict: accept`]);
    const agents = { [adapter]: worker, other: reviewer };
    const overrides = INIT_OVERRIDES.map((value) =>
      value === "fake1" ? adapter : value === "fake2" ? "other" : value,
    );

    await executeRoleCommand(withRepo(dispatchArgv(overrides), repo), {
      agents,
      stdin: stdinPrompt,
    });
    await reviewerTurn(repo, agents);

    const squash = (text) => text.replace(/\s+/g, " ");
    expect(squash(worker.recorded[0].prompt)).toContain(SECRET_RULE);
    expect(squash(reviewer.recorded[0].prompt)).toContain(SECRET_RULE);
  });
}
