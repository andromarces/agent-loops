import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createTurnEvidence } from "../../../src/lib/evidence/turn-evidence-window.mjs";
import { removePath } from "../../fs-helpers.mjs";

let inherited;
let literal;
beforeEach(async () => {
  inherited = await mkdtemp(join(tmpdir(), "window-inherited-"));
  literal = await mkdtemp(join(tmpdir(), "window-literal-"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, inherited);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removePath(inherited);
  await removePath(literal);
});

const evidence = (isWorker) =>
  createTurnEvidence({
    cwd: inherited,
    signal: undefined,
    isWorker,
    localFilesCopied: [],
    sharedGitReadBoundMs: 1000,
    tmpdirLiteralRoots: [literal],
  });

// Usefulness: verifies the reviewer turn's evidence read reports an entry of a literal system
// temporary directory that differs from the inherited one (issue #1713), in process and with no
// child process.
test("a reviewer turn reports a literal system temporary directory entry", async () => {
  const turn = evidence(false);
  await turn.beforeTurn();
  await writeFile(join(literal, "x"), "probe");
  expect(await turn.advisory()).toEqual({
    inheritedTmpdirEntries: ["literal-tmp/x"],
    packageStoreEntries: [],
  });
});
