import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main, parseArgs } from "../src/cli.mjs";
import { createLinkedWorkTree, removePath } from "./runtime-helpers.mjs";

const SECRET = "TOKEN-VALUE-MUST-NOT-APPEAR";
const BASE = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy", "--task", "t"];
const FINISH = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});
const created = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    await removePath(dir);
  }
});

const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

// Usefulness: verifies the copy is on by default and the opt-out flag turns it
// off, and that the boolean flag rejects an inline value like every other one.
// Not redundant: it parses argv and stops there. The other two tests in this file run `main`.
test("--no-copy-local-files parses as an opt-out and takes no value", () => {
  expect(parseArgs(BASE).copyLocalFiles).toBe(true);
  expect(parseArgs([...BASE, "--no-copy-local-files"]).copyLocalFiles).toBe(false);
  expect(() => parseArgs([...BASE, "--no-copy-local-files=1"])).toThrow(
    "--no-copy-local-files does not take a value.",
  );
});

async function runHeadless(flags) {
  const tree = await createLinkedWorkTree({ ignore: [".env"] });
  created.push(tree.base);
  await writeFile(join(tree.main, ".env"), `KEY=${SECRET}\n`);
  const transcript = join(tree.base, "transcript.json");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;
  try {
    await main([...BASE, ...flags, "--cwd", tree.linked, "--transcript", transcript], {
      codex: { run: async () => FINISH },
      claude: { run: async () => "worker" },
      agy: { run: async () => "reviewer" },
    });
  } finally {
    process.exitCode = origExitCode;
  }
  return { linked: tree.linked, transcript: await readFile(transcript, "utf8") };
}

// Usefulness: verifies the headless command copies by default, and the
// transcript names the file and never holds its content (acceptance 1, 6).
// Not redundant: it runs `main` end to end and reads the transcript file. The runtime test calls `runLoop` directly.
test("headless command copies by default and the transcript holds names only", async () => {
  const { linked, transcript } = await runHeadless([]);

  expect(await exists(join(linked, ".env"))).toBe(true);
  expect(transcript).toContain('"type": "local-files"');
  expect(transcript).toContain(".env");
  expect(transcript).not.toContain(SECRET);
});

// Usefulness: verifies the flag reaches the loop, so the opt-out copies
// nothing on the headless command (acceptance 4).
// Not redundant: it runs `main` with the flag. The parse test stops at argv.
test("headless --no-copy-local-files copies nothing", async () => {
  const { linked, transcript } = await runHeadless(["--no-copy-local-files"]);

  expect(await exists(join(linked, ".env"))).toBe(false);
  expect(transcript).not.toContain("local-files");
});
