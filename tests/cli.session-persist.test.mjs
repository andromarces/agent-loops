import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { runClaude } from "../src/agents/claude.mjs";
import { main } from "../src/cli.mjs";
import { exec } from "../src/lib/exec.mjs";
import { createTempRepo, removePath } from "./runtime-helpers.mjs";

vi.mock("../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Fails `git status` from its `failFrom`-th call on, so a test can break the snapshot that follows a
// turn. The real `execa` answers every other call.
const git = vi.hoisted(() => ({ statusCalls: 0, failFrom: Infinity }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) => {
      if (command === "git" && args[0] === "status" && ++git.statusCalls >= git.failFrom) {
        return Promise.resolve({ exitCode: 128, stdout: "", stderr: "git read failed" });
      }
      return real.execa(command, args, options);
    },
  };
});

const WORK = JSON.stringify({ action: "run_worker", prompt: "w" });
const REVIEW = JSON.stringify({ action: "run_reviewer", prompt: "r" });
const FINISH = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let repo;
let scratch;
const exitCode = process.exitCode;

beforeEach(async () => {
  repo = await realpath(await createTempRepo());
  scratch = await realpath(await mkdtemp(join(tmpdir(), "session-persist-")));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(scratch, "claude-config"));
  vi.mocked(exec).mockReset();
  git.statusCalls = 0;
  git.failFrom = Infinity;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removePath(repo);
  await rm(scratch, { recursive: true, force: true });
});

const roleArgs = (kinds) => [
  "--orchestrator",
  kinds.orchestrator ?? "codex",
  "--worker",
  kinds.worker ?? "agy",
  "--reviewer",
  kinds.reviewer ?? "agy",
  "--task",
  "long task",
];

// A scripted adapter for the roles that these tests do not run through the real Claude adapter.
function scripted(replies) {
  let call = 0;
  return {
    async run(state) {
      state.sessionId ??= "fake-session";
      return replies[call++] ?? "ok";
    },
  };
}

const agentsFor = (replies) => ({
  codex: scripted(replies),
  agy: scripted([]),
  claude: { run: runClaude },
});

/** The id the adapter pre-assigned in this `exec` call. */
const assignedIn = (args) => args[args.indexOf("--session-id") + 1];

const timedOut = () =>
  Object.assign(new Error("claude timed out."), { stdout: "", stderr: "", timedOut: true });

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/** Writes the session file that Claude Code writes for a first turn the CLI started. */
async function saveSession(id, role) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-saved");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.jsonl`),
    JSON.stringify({
      type: "user",
      cwd: repo,
      sessionId: id,
      message: { role: "user", content: `p\n\n[agent-loop session ${id} role ${role}]` },
    }),
  );
}

// Usefulness: verifies a failed first turn whose output reports another session id keeps the id the
// CLI reported, not the pre-assigned one, so the persisted record never holds a stale id with no
// unconfirmed mark (#564 review). No other test runs the real adapter through the headless loop.
test("a failed first turn keeps the id the CLI reported", async () => {
  const transcript = join(scratch, "run.json");
  vi.mocked(exec).mockImplementationOnce(async () => {
    throw Object.assign(new Error("exit 1"), {
      stdout: JSON.stringify({ type: "result", session_id: "reported-id", is_error: true }),
      stderr: "",
      exitCode: 1,
    });
  });
  await main(
    [...roleArgs({ worker: "claude" }), "--cwd", repo, "--transcript", transcript],
    agentsFor([WORK, FINISH]),
  );
  expect(process.exitCode).toBe(0);
  const { roles } = await readJson(transcript);
  expect(roles.worker.sessionId).toBe("reported-id");
  expect(roles.worker.sessionUnconfirmed).toBeUndefined();
});

// Usefulness: verifies a first turn that the CLI rejects as an id already in use leaves no id in
// the transcript, so a later run never resumes a session that another work tree owns (#564 review).
test("a first turn rejected as in use leaves no session id in the transcript", async () => {
  const transcript = join(scratch, "run.json");
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
    throw Object.assign(new Error("exit 1"), {
      stdout: "",
      stderr: `Error: Session ID ${assignedIn(args)} is already in use.\n`,
      exitCode: 1,
    });
  });
  await main(
    [...roleArgs({ worker: "claude" }), "--cwd", repo, "--transcript", transcript],
    agentsFor([WORK, FINISH]),
  );
  const { roles } = await readJson(transcript);
  expect(roles.worker.sessionId).toBeNull();
  expect(roles.worker.sessionUnconfirmed).toBeUndefined();
});

// Usefulness: verifies a transcript that a parent kill left mid-turn resumes the pre-assigned id
// only after the real ownership check finds a session file for this work tree and role, and that
// an id with no such file starts a new session instead (#564 acceptance).
test.each([
  { owned: true, expectResume: true },
  { owned: false, expectResume: false },
])("--continue-from of a mid-turn transcript (session saved: $owned)", async ({ owned }) => {
  const transcript = join(scratch, "run.json");
  let midTurn;
  let killedId;
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
    killedId = assignedIn(args);
    midTurn = await readFile(transcript, "utf8");
    throw timedOut();
  });
  await main(
    [...roleArgs({ worker: "claude" }), "--cwd", repo, "--transcript", transcript],
    agentsFor([WORK, FINISH]),
  );
  const record = JSON.parse(midTurn);
  expect(record.roles.worker).toMatchObject({ sessionId: killedId, sessionUnconfirmed: true });

  // The mid-turn file is what a kill leaves behind.
  await writeFile(transcript, midTurn);
  if (owned) await saveSession(killedId, "worker");
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockImplementation(async (_command, args) => {
    const id = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : assignedIn(args);
    return { stdout: JSON.stringify({ session_id: id, result: "worker ok" }), stderr: "" };
  });
  await main(
    [
      ...roleArgs({ worker: "claude" }),
      "--cwd",
      repo,
      "--continue-from",
      transcript,
      "--transcript",
      transcript,
    ],
    agentsFor([WORK, FINISH]),
  );
  expect(process.exitCode).toBe(0);
  const args = vi.mocked(exec).mock.calls.at(-1)[1];
  if (owned) {
    expect(args).toEqual(expect.arrayContaining(["--resume", killedId]));
    expect(args).not.toContain("--session-id");
  } else {
    expect(args).not.toContain("--resume");
    expect(assignedIn(args)).toMatch(UUID);
    expect(assignedIn(args)).not.toBe(killedId);
  }
});

// Usefulness: verifies a --transcript file inside the work tree never makes a read-only turn fail
// the mutation check, because the pre-spawn write is skipped there (#564 review).
test("an in-tree transcript causes no mutation failure for a Claude reviewer", async () => {
  const transcript = join(repo, "run.json");
  vi.mocked(exec).mockImplementation(async (_command, args) => ({
    stdout: JSON.stringify({ session_id: assignedIn(args), result: "Verdict: accept" }),
    stderr: "",
  }));
  await main(
    [...roleArgs({ reviewer: "claude" }), "--cwd", repo, "--transcript", transcript],
    agentsFor([REVIEW, FINISH]),
  );
  expect(process.exitCode).toBe(0);
  const { error, roles } = await readJson(transcript);
  expect(error).toBeNull();
  expect(roles.reviewer.sessionId).toMatch(UUID);
});

// Usefulness: verifies a Claude orchestrator first turn is in the transcript before its CLI starts,
// with the unconfirmed mark, like the worker and reviewer turns (#564 review).
test("a Claude orchestrator's pre-assigned id reaches the transcript before the turn", async () => {
  const transcript = join(scratch, "run.json");
  let midTurn;
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
    midTurn = await readJson(transcript);
    return {
      stdout: JSON.stringify({ session_id: assignedIn(args), result: FINISH }),
      stderr: "",
    };
  });
  await main(
    [...roleArgs({ orchestrator: "claude" }), "--cwd", repo, "--transcript", transcript],
    agentsFor([]),
  );
  expect(process.exitCode).toBe(0);
  expect(midTurn.roles.orchestrator).toMatchObject({ sessionUnconfirmed: true });
  expect(midTurn.roles.orchestrator.sessionId).toMatch(UUID);
});

// Runs a Claude reviewer turn whose --transcript is `transcript`, with `--cwd` set to `cwd`.
async function reviewerRun(transcript, cwd) {
  vi.mocked(exec).mockImplementation(async (_command, args) => ({
    stdout: JSON.stringify({ session_id: assignedIn(args), result: "Verdict: accept" }),
    stderr: "",
  }));
  await main(
    [...roleArgs({ reviewer: "claude" }), "--cwd", cwd, "--transcript", transcript],
    agentsFor([REVIEW, FINISH]),
  );
}

// Usefulness: verifies a --transcript inside the repository but outside --cwd causes no mutation
// failure, because the mutation snapshot covers the whole Git work tree, not only --cwd (#564 review).
test("a transcript inside the repository but outside --cwd causes no reviewer mutation failure", async () => {
  const cwd = join(repo, "sub");
  await mkdir(cwd);
  const transcript = join(repo, "run.json");
  await reviewerRun(transcript, cwd);
  expect(process.exitCode).toBe(0);
  expect((await readJson(transcript)).error).toBeNull();
});

// Usefulness: verifies a work tree directory whose name starts with two dots counts as inside the
// work tree, so the pre-spawn write is skipped there (#564 review).
test("a transcript in a directory named '..records' inside the work tree causes no mutation failure", async () => {
  const dir = join(repo, "..records");
  await mkdir(dir);
  const transcript = join(dir, "run.json");
  await reviewerRun(transcript, repo);
  expect(process.exitCode).toBe(0);
  expect((await readJson(transcript)).error).toBeNull();
});

// Usefulness: verifies an orchestrator id that the ownership check rejects keeps its unconfirmed
// mark in the written record, so a later --continue-from checks it again, also when the snapshot
// after the turn fails and wraps the refusal (#564 review).
test.each([{ snapshotFails: false }, { snapshotFails: true }])(
  "a rejected orchestrator id keeps its unconfirmed mark (snapshot fails: $snapshotFails)",
  async ({ snapshotFails }) => {
    const earlier = join(scratch, "earlier.json");
    const next = join(scratch, "next.json");
    const role = (kind, sessionId, extra = {}) => ({
      kind,
      model: null,
      effort: null,
      sessionId,
      ...extra,
    });
    await writeFile(
      earlier,
      JSON.stringify({
        cwd: repo,
        roles: {
          orchestrator: role("claude", "11111111-1111-4111-8111-111111111111", {
            sessionUnconfirmed: true,
          }),
          worker: role("agy", null),
          reviewer: role("agy", null),
        },
        events: [],
      }),
    );
    // The turn takes one snapshot before and one after it. Only the second one fails.
    if (snapshotFails) git.failFrom = 2;
    await main(
      [
        ...roleArgs({ orchestrator: "claude" }),
        "--cwd",
        repo,
        "--continue-from",
        earlier,
        "--transcript",
        next,
      ],
      agentsFor([]),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect((await readJson(next)).roles.orchestrator).toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionUnconfirmed: true,
    });
  },
);
