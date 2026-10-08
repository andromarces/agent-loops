import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { runClaude } from "../src/agents/claude.mjs";
import { main } from "../src/cli.mjs";
import { exec } from "../src/lib/exec.mjs";
import { readContinuation } from "../src/lib/continuation.mjs";
import { sessionRecordPath } from "../src/lib/session-record.mjs";
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
  await rm(join(tmpdir(), "agent-loops"), { recursive: true, force: true });
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

// What --continue-from restores from `transcript` while a turn runs: the transcript file with the
// session record of an in-tree transcript applied.
const readMidTurn = (transcript) => readContinuation(transcript).catch(() => undefined);

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

// Usefulness: verifies a Claude orchestrator first turn is in the transcript before its CLI starts,
// with the unconfirmed mark, like the worker and reviewer turns (#564 review).
test("a Claude orchestrator's pre-assigned id reaches the transcript before the turn", async () => {
  const transcript = join(scratch, "run.json");
  let midTurn;
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
    midTurn = await readMidTurn(transcript);
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

// Runs a Claude reviewer turn whose --transcript is `transcript`, with `--cwd` set to `cwd`. Returns
// the transcript as the CLI saw it mid-turn. `during` runs inside the turn, before the CLI answers.
async function reviewerRun(transcript, cwd, during = async () => {}) {
  let midTurn;
  vi.mocked(exec).mockImplementation(async (_command, args) => {
    midTurn = await readMidTurn(transcript);
    await during();
    return {
      stdout: JSON.stringify({ session_id: assignedIn(args), result: "Verdict: accept" }),
      stderr: "",
    };
  });
  await main(
    [...roleArgs({ reviewer: "claude" }), "--cwd", cwd, "--transcript", transcript],
    agentsFor([REVIEW, FINISH]),
  );
  return midTurn;
}

const expectRecorded = (role, midTurn) => {
  expect(midTurn.roles[role]).toMatchObject({ sessionUnconfirmed: true });
  expect(midTurn.roles[role].sessionId).toMatch(UUID);
};

// Usefulness: verifies an in-tree transcript gives --continue-from the pre-assigned id before a
// Claude reviewer CLI starts, and the turn passes its mutation check (issue #581).
test("an in-tree transcript is written before a Claude reviewer turn without a mutation failure", async () => {
  const transcript = join(repo, "run.json");
  const midTurn = await reviewerRun(transcript, repo);
  expect(process.exitCode).toBe(0);
  expectRecorded("reviewer", midTurn);
  expect((await readJson(transcript)).error).toBeNull();
});

// Usefulness: verifies the same for a Claude orchestrator first turn, the other turn under the check.
test("an in-tree transcript is written before a Claude orchestrator turn without a mutation failure", async () => {
  const transcript = join(repo, "run.json");
  let midTurn;
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
    midTurn = await readMidTurn(transcript);
    return { stdout: JSON.stringify({ session_id: assignedIn(args), result: FINISH }), stderr: "" };
  });
  await main(
    [...roleArgs({ orchestrator: "claude" }), "--cwd", repo, "--transcript", transcript],
    agentsFor([]),
  );
  expect(process.exitCode).toBe(0);
  expectRecorded("orchestrator", midTurn);
  expect((await readJson(transcript)).error).toBeNull();
});

// Usefulness: verifies the mutation check stays exact: a reviewer that writes another file in an
// in-tree transcript run still fails the check (issue #581).
test("an in-tree transcript leaves the mutation check exact for every other path", async () => {
  const transcript = join(repo, "run.json");
  await reviewerRun(transcript, repo, () => writeFile(join(repo, "leak.txt"), "leak\n"));
  expect(process.exitCode).toBe(1);
  const { error } = await readJson(transcript);
  expect(error).toContain("Mutation detected during reviewer turn");
  expect(error).toContain("leak.txt");
  expect(error).not.toContain("run.json");
});

// Usefulness: verifies a transcript inside the repository but outside --cwd counts as in tree,
// because the mutation snapshot covers the whole Git work tree.
test("a transcript inside the repository but outside --cwd is written before the reviewer turn", async () => {
  const cwd = join(repo, "sub");
  await mkdir(cwd);
  const transcript = join(repo, "run.json");
  const midTurn = await reviewerRun(transcript, cwd);
  expect(process.exitCode).toBe(0);
  expectRecorded("reviewer", midTurn);
  expect((await readJson(transcript)).error).toBeNull();
});

// Usefulness: verifies a work tree directory whose name starts with two dots counts as in tree.
test("a transcript in a directory named '..records' inside the work tree is written before the reviewer turn", async () => {
  const dir = join(repo, "..records");
  await mkdir(dir);
  const transcript = join(dir, "run.json");
  const midTurn = await reviewerRun(transcript, repo);
  expect(process.exitCode).toBe(0);
  expectRecorded("reviewer", midTurn);
  expect((await readJson(transcript)).error).toBeNull();
});

const git_ = (cwd, ...args) => execa("git", args, { cwd });

// Adds a submodule `sub` to the test repository and commits it.
async function addSubmodule() {
  const source = join(scratch, "subsrc");
  await mkdir(source);
  await git_(source, "init", "-q");
  await git_(
    source,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  );
  await writeFile(join(source, "f.txt"), "f\n");
  await git_(source, "add", ".");
  await git_(source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "f");
  await git_(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
  await git_(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "sub");
}

// Usefulness: verifies a transcript named like a mutation marker never hides a reviewer commit.
test.skipIf(process.platform === "win32")(
  "a transcript named '<HEAD>' inside the work tree still reports a reviewer commit",
  async () => {
    const transcript = join(repo, "<HEAD>");
    await reviewerRun(transcript, repo, () =>
      git_(
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      ),
    );
    expect(process.exitCode).toBe(1);
  },
);

// Usefulness: verifies a transcript path that names a submodule never hides a change inside it.
test("a transcript path that names a submodule still reports a reviewer change inside it", async () => {
  await addSubmodule();
  await reviewerRun(join(repo, "sub"), repo, () =>
    writeFile(join(repo, "sub", "f.txt"), "changed\n"),
  );
  expect(process.exitCode).toBe(1);
});

// Usefulness: verifies a transcript inside a submodule causes no mutation failure, although the
// outer snapshot sees a write there as a dirty submodule.
test("a transcript inside a submodule causes no reviewer mutation failure", async () => {
  await addSubmodule();
  await reviewerRun(join(repo, "sub", "run.json"), repo);
  expect(process.exitCode).toBe(0);
});

// Whether `A` and `a` name one file on this file system.
async function caseInsensitive() {
  await writeFile(join(scratch, "probe-a"), "");
  return readFile(join(scratch, "PROBE-A")).then(
    () => true,
    () => false,
  );
}

// Usefulness: verifies a case alias of the transcript path causes no mutation failure on a
// case-insensitive file system.
test("a case alias of an in-tree transcript causes no reviewer mutation failure", async (ctx) => {
  if (!(await caseInsensitive())) ctx.skip();
  await writeFile(join(repo, "run.json"), "{}");
  await reviewerRun(join(repo, "RUN.json"), repo);
  expect(process.exitCode).toBe(0);
});

// The files that the loop leaves on disk during a turn: the transcript and the session records. A
// parent that dies mid-turn leaves exactly these.
async function captureDisk(transcript) {
  const files = new Map();
  const add = async (path) => {
    files.set(path, await readFile(path, "utf8").catch(() => null));
  };
  await add(transcript);
  const root = join(tmpdir(), "agent-loops");
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.isFile()) await add(join(entry.parentPath, entry.name));
  }
  return files;
}

async function restoreDisk(transcript, files) {
  await rm(transcript, { force: true });
  await rm(join(tmpdir(), "agent-loops"), { recursive: true, force: true });
  for (const [path, text] of files) {
    if (text === null) continue;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  }
}

// Usefulness: verifies the acceptance of issue #581: a parent that dies during a Claude orchestrator
// or reviewer first turn, with the transcript inside the work tree, leaves a record that
// --continue-from resumes after the ownership check, and no turn fails its mutation check.
test.each(["orchestrator", "reviewer"])(
  "--continue-from resumes a %s turn that a parent crash left with an in-tree transcript",
  async (role) => {
    const transcript = join(repo, "run.json");
    let killedId;
    let disk;
    vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
      killedId = assignedIn(args);
      disk = await captureDisk(transcript);
      throw timedOut();
    });
    await main(
      [...roleArgs({ [role]: "claude" }), "--cwd", repo, "--transcript", transcript],
      agentsFor([REVIEW, FINISH]),
    );
    expect(killedId).toMatch(UUID);
    expect((await readJson(transcript)).error ?? "").not.toContain("Mutation detected");

    await restoreDisk(transcript, disk);
    await saveSession(killedId, role);
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockImplementation(async (_command, args) => {
      const id = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : assignedIn(args);
      return {
        stdout: JSON.stringify({
          session_id: id,
          result: role === "reviewer" ? "Verdict: accept" : FINISH,
        }),
        stderr: "",
      };
    });
    await main(
      [
        ...roleArgs({ [role]: "claude" }),
        "--cwd",
        repo,
        "--continue-from",
        transcript,
        "--transcript",
        transcript,
      ],
      agentsFor([REVIEW, FINISH]),
    );
    expect(process.exitCode).toBe(0);
    const first = vi.mocked(exec).mock.calls[0][1];
    expect(first).toEqual(expect.arrayContaining(["--resume", killedId]));
  },
);

// Parent crash during an orchestrator first turn with an in-tree transcript. Returns the pre-assigned
// id and the files on disk at that moment.
async function crashOrchestrator(transcript) {
  let killedId;
  let disk;
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
    killedId = assignedIn(args);
    disk = await captureDisk(transcript);
    throw timedOut();
  });
  await main(
    [...roleArgs({ orchestrator: "claude" }), "--cwd", repo, "--transcript", transcript],
    agentsFor([]),
  );
  return { killedId, disk };
}

// Runs --continue-from on `transcript` and returns the arguments of the first Claude call.
async function continueFrom(transcript) {
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockImplementation(async (_command, args) => {
    const id = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : assignedIn(args);
    return { stdout: JSON.stringify({ session_id: id, result: FINISH }), stderr: "" };
  });
  await main(
    [
      ...roleArgs({ orchestrator: "claude" }),
      "--cwd",
      repo,
      "--continue-from",
      transcript,
      "--transcript",
      transcript,
    ],
    agentsFor([]),
  );
  return vi.mocked(exec).mock.calls[0]?.[1];
}

// The one file of a captured disk that is not the transcript: the session record.
const recordIn = (disk, transcript) => [...disk.keys()].find((path) => path !== transcript);

// Usefulness: verifies the record holds only the id, the mark, and the binding fields. No task text
// leaves the transcript file.
test("the session record holds no transcript content", async () => {
  const transcript = join(repo, "run.json");
  const { killedId, disk } = await crashOrchestrator(transcript);
  const record = JSON.parse(disk.get(recordIn(disk, transcript)));
  expect(Object.keys(record).sort()).toEqual([
    "cwd",
    "role",
    "runNonce",
    "sessionId",
    "sessionUnconfirmed",
    "transcript",
    "transcriptSha256",
    "version",
  ]);
  expect(record).toMatchObject({ role: "orchestrator", sessionId: killedId, cwd: repo });
  expect(JSON.stringify(record)).not.toContain("long task");
  expect(JSON.parse(disk.get(transcript)).runNonce).toBe(record.runNonce);
});

// Usefulness: verifies a transcript outside the work tree keeps its earlier shape: it has no run
// nonce, because no record binds to it.
test("a transcript outside the work tree holds no run nonce", async () => {
  const transcript = join(scratch, "run.json");
  await main([...roleArgs({}), "--cwd", repo, "--transcript", transcript], agentsFor([FINISH]));
  expect(await readJson(transcript)).not.toHaveProperty("runNonce");
});

// Usefulness: verifies a record that does not bind to this transcript and work tree gives no id to
// --continue-from, although a session file backs the id.
test.each([
  ["without the unconfirmed mark", (r) => ({ ...r, sessionUnconfirmed: false })],
  ["with an extra field", (r) => ({ ...r, task: "long task" })],
  ["for another work tree", (r) => ({ ...r, cwd: join(r.cwd, "other") })],
  ["for another role", (r) => ({ ...r, role: "worker" })],
  ["with an id that is not a UUID", (r) => ({ ...r, sessionId: "../../x" })],
  ["with an id that is an array holding a UUID", (r) => ({ ...r, sessionId: [r.sessionId] })],
  ["with an id that is a number", (r) => ({ ...r, sessionId: 7 })],
  ["with a run nonce that is not a UUID", (r) => ({ ...r, runNonce: "x" })],
  ["for another transcript key", (r) => ({ ...r, transcript: "0".repeat(32) })],
])("--continue-from refuses a record %s", async (_name, edit) => {
  const transcript = join(repo, "run.json");
  const { killedId, disk } = await crashOrchestrator(transcript);
  await restoreDisk(transcript, disk);
  const file = recordIn(disk, transcript);
  await writeFile(file, JSON.stringify(edit(JSON.parse(disk.get(file)))));
  await saveSession(killedId, "orchestrator");
  const args = await continueFrom(transcript);
  expect(process.exitCode).toBe(0);
  expect(args).not.toContain("--resume");
  expect(args).toContain("--session-id");
});

// Usefulness: verifies a record that another transcript wrote is refused when it sits under the
// key of this transcript.
test("--continue-from refuses the record of another transcript", async () => {
  const first = join(repo, "a.json");
  const second = join(repo, "b.json");
  const { killedId, disk } = await crashOrchestrator(first);
  const secondDisk = await (async () => {
    await restoreDisk(first, disk);
    await rm(first);
    await writeFile(second, disk.get(first));
    const target = await sessionRecordPath(second);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, disk.get(recordIn(disk, first)));
    return target;
  })();
  expect(secondDisk).not.toBe(recordIn(disk, first));
  await saveSession(killedId, "orchestrator");
  const args = await continueFrom(second);
  expect(process.exitCode).toBe(0);
  expect(args).not.toContain("--resume");
});

// Usefulness: verifies a record that an earlier run left at the same transcript path never gives its
// id to a later run, although both runs have the same task, work tree, and transcript bytes.
test("--continue-from refuses the record of another run with identical content", async () => {
  const transcript = join(repo, "run.json");
  const first = await crashOrchestrator(transcript);
  const second = await crashOrchestrator(transcript);
  expect(second.killedId).not.toBe(first.killedId);
  await restoreDisk(transcript, second.disk);
  const file = recordIn(second.disk, transcript);
  await writeFile(file, first.disk.get(recordIn(first.disk, transcript)));
  await saveSession(first.killedId, "orchestrator");
  const args = await continueFrom(transcript);
  expect(process.exitCode).toBe(0);
  expect(args).not.toContain("--resume");
});

// Usefulness: verifies a record that a later transcript write replaced is ignored, whatever the
// file times are. The current transcript decides.
test("--continue-from ignores a record that a later transcript write superseded", async () => {
  const transcript = join(repo, "run.json");
  const { killedId, disk } = await crashOrchestrator(transcript);
  await restoreDisk(transcript, disk);
  const current = JSON.parse(await readFile(transcript, "utf8"));
  current.roles.orchestrator.sessionId = "22222222-2222-4222-8222-222222222222";
  delete current.roles.orchestrator.sessionUnconfirmed;
  await writeFile(transcript, JSON.stringify(current));
  const when = new Date(Date.now() - 5000);
  await utimes(transcript, when, when);
  await utimes(recordIn(disk, transcript), when, when);
  await saveSession(killedId, "orchestrator");
  const args = await continueFrom(transcript);
  expect(process.exitCode).toBe(0);
  expect(args).toEqual(expect.arrayContaining(["--resume", current.roles.orchestrator.sessionId]));
  expect(args).not.toContain(killedId);
});

// Usefulness: verifies a case alias of the transcript path finds the record on a case-insensitive
// file system.
test("--continue-from finds the record through a case alias of the transcript path", async (ctx) => {
  if (!(await caseInsensitive())) ctx.skip();
  const transcript = join(repo, "run.json");
  const { killedId, disk } = await crashOrchestrator(transcript);
  await restoreDisk(transcript, disk);
  await saveSession(killedId, "orchestrator");
  const args = await continueFrom(join(repo, "RUN.json"));
  expect(args).toEqual(expect.arrayContaining(["--resume", killedId]));
});

// Usefulness: verifies the ownership check always runs on a recorded id. An orchestrator has no
// first-turn rerun, so an id that no session file backs ends the run before any CLI starts.
test("--continue-from refuses a recorded orchestrator id that no session file backs", async () => {
  const transcript = join(repo, "run.json");
  const { disk } = await crashOrchestrator(transcript);
  await restoreDisk(transcript, disk);
  const args = await continueFrom(transcript);
  expect(args).toBeUndefined();
  expect(process.exitCode).toBe(1);
});

// Usefulness: verifies a rejected id leaves no record, and the withdrawal writes no in-tree file,
// so the reviewer turn passes its mutation check.
test("a rejected id leaves no record for an in-tree reviewer turn", async () => {
  const transcript = join(repo, "run.json");
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
    throw Object.assign(new Error("exit 1"), {
      stdout: "",
      stderr: `Error: Session ID ${assignedIn(args)} is already in use.\n`,
      exitCode: 1,
    });
  });
  await main(
    [...roleArgs({ reviewer: "claude" }), "--cwd", repo, "--transcript", transcript],
    agentsFor([REVIEW, FINISH]),
  );
  const disk = await captureDisk(transcript);
  expect(process.exitCode).toBe(0);
  expect(recordIn(disk, transcript)).toBeUndefined();
  expect((await readJson(transcript)).roles.reviewer.sessionId).toBeNull();
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
