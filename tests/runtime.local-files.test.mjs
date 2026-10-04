import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runLoop } from "../src/runtime.mjs";
import { createLinkedWorkTree, removePath, scripted } from "./runtime-helpers.mjs";

const SECRET = "TOKEN-VALUE-MUST-NOT-APPEAR";
const created = [];

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await removePath(dir);
  }
});

const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const FINISH = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});

async function runIn(linked, extra = {}) {
  let presentAtFirstTurn = null;
  const events = [];
  const orchestrator = {
    async run() {
      presentAtFirstTurn = await exists(join(linked, ".env"));
      return FINISH;
    },
  };
  const result = await runLoop({
    task: "t",
    cwd: linked,
    maxSteps: 3,
    roles: {
      orchestrator: { kind: "orch", sessionId: null },
      worker: { kind: "work", sessionId: null },
      reviewer: { kind: "rev", sessionId: null },
    },
    agents: { orch: orchestrator, work: scripted([]), rev: scripted([]) },
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { result, presentAtFirstTurn, events };
}

async function linkedWithEnv() {
  const tree = await createLinkedWorkTree({ ignore: [".env"] });
  created.push(tree.base);
  await writeFile(join(tree.main, ".env"), `KEY=${SECRET}\n`);
  return tree;
}

// Usefulness: verifies acceptance 1 on the headless path — the file is in
// --cwd before the first orchestrator turn, which is the first child spawn and
// the first snapshot, and a local-files event names it without content.
// Not redundant: the role test covers the interactive path, and only this one fails when `runLoop` copies after the first orchestrator turn.
test("headless run copies local files before the first turn and reports names", async () => {
  const { linked } = await linkedWithEnv();

  const { result, presentAtFirstTurn, events } = await runIn(linked);

  expect(result.exitCode).toBe(0);
  expect(presentAtFirstTurn).toBe(true);
  const event = events.find((e) => e.type === "local-files");
  expect(event).toMatchObject({ copied: [".env"], skipped: [] });
  expect(JSON.stringify(events)).not.toContain(SECRET);
});

// Usefulness: verifies acceptance 4 on the headless path — the opt-out copies
// nothing and emits no event.
// Not redundant: the CLI test passes the flag through `main`, and only this one fails when `runLoop` ignores its own option.
test("headless copyLocalFiles false copies nothing", async () => {
  const { linked } = await linkedWithEnv();

  const { presentAtFirstTurn, events } = await runIn(linked, { copyLocalFiles: false });

  expect(presentAtFirstTurn).toBe(false);
  expect(events.some((e) => e.type === "local-files")).toBe(false);
});
