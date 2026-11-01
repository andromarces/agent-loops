import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { stateRoot } from "../../src/lib/runstate.mjs";
import { sessionRecordsRoot } from "../../src/lib/session-record.mjs";
import { slotsRoot } from "../../src/lib/slots-root.mjs";
import { removePath, symlinkOrSkip } from "../fs-helpers.mjs";
import { OK_EVENTS, withInheritedTmp, fakeCodex, runTurn } from "./codex-tmpdir-helpers.mjs";

// Only `exec` is replaced: the turn directory removal runs its helper through `execBounded`.
vi.mock("../../src/lib/exec.mjs", async (importActual) => ({
  ...(await importActual()),
  exec: vi.fn(),
}));

const ROOT_OVERRIDES = [
  "AGENT_LOOP_RUNS_ROOT",
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_SESSION_RECORDS_ROOT",
];
const LIB = (name) => new URL(`../../src/lib/${name}`, import.meta.url).href;
const RESOLVE_ROOTS = `
const [{ stateRoot }, { slotsRoot }, { sessionRecordsRoot }] = await Promise.all([
  import(${JSON.stringify(LIB("runstate.mjs"))}),
  import(${JSON.stringify(LIB("slots-root.mjs"))}),
  import(${JSON.stringify(LIB("session-record.mjs"))}),
]);
console.log(JSON.stringify({ runs: stateRoot(), slots: slotsRoot(), records: sessionRecordsRoot() }));`;

// Runs the three machine-wide root lookups in a child that gets the environment of a Codex turn.
async function rootsSeenByChild(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  const saved = ROOT_OVERRIDES.map((name) => process.env[name]);
  try {
    for (const name of ROOT_OVERRIDES) delete process.env[name];
    Object.assign(process.env, overrides);
    let childRoots;
    fakeCodex(async (_home, env) => {
      const { stdout } = await execa(
        process.execPath,
        ["--input-type=module", "-e", RESOLVE_ROOTS],
        {
          env,
        },
      );
      childRoots = JSON.parse(stdout);
      return { stdout: OK_EVENTS, stderr: "" };
    });
    const parentRoots = await withInheritedTmp(root, async () => {
      const parent = { runs: stateRoot(), slots: slotsRoot(), records: sessionRecordsRoot() };
      await runTurn();
      return parent;
    });
    return { parentRoots, childRoots };
  } finally {
    ROOT_OVERRIDES.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
    await removePath(root);
  }
}

// Usefulness: verifies a child of a Codex turn shares the test-slot directory, the runs root, and
// the session records with its parent, so the private temporary directory splits no host state.
test("a child of a codex turn resolves the same machine-wide roots as the parent", async () => {
  const { parentRoots, childRoots } = await rootsSeenByChild();
  expect(childRoots).toEqual(parentRoots);
});

// Usefulness: verifies a user value of a root override still wins in the child of a Codex turn.
test("a user root override wins in the child of a codex turn", async () => {
  const mine = join(tmpdir(), "my-roots");
  const { childRoots } = await rootsSeenByChild({
    AGENT_LOOP_RUNS_ROOT: join(mine, "runs"),
    AGENT_LOOP_TEST_SLOTS_ROOT: join(mine, "slots"),
    AGENT_LOOP_SESSION_RECORDS_ROOT: join(mine, "records"),
  });
  expect(childRoots).toEqual({
    runs: join(mine, "runs"),
    slots: join(mine, "slots"),
    records: join(mine, "records"),
  });
});

const CLASSIFY_ROOTS = (layouts) => `
const { isEphemeralPackageRoot } = await import(${JSON.stringify(
  new URL("../../src/install/package-root.mjs", import.meta.url).href,
)});
console.log(JSON.stringify(${JSON.stringify(layouts)}.map((root) => isEphemeralPackageRoot(root))));`;

// Usefulness: verifies the installer refusal of an ephemeral package-runner root holds inside a
// Codex turn, so the private temporary directory cannot turn an inherited `yarn dlx` launcher
// into an accepted install source.
test("a child of a codex turn classifies package-runner roots as the parent does", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    const layouts = [
      join(root, "xfs-abc123", "dlx-4242", "node_modules", "pkg"),
      join(root, "bunx-501-pkg@1.0.0", "node_modules", "pkg"),
      join(root, "_npx", "0123456789abcdef", "node_modules", "pkg"),
      join(root, "stable", "node_modules", "pkg"),
    ];
    await mkdir(layouts[3], { recursive: true });
    let childAnswer;
    fakeCodex(async (_home, env) => {
      const { stdout } = await execa(
        process.execPath,
        ["--input-type=module", "-e", CLASSIFY_ROOTS(layouts)],
        { env },
      );
      childAnswer = JSON.parse(stdout);
      return { stdout: OK_EVENTS, stderr: "" };
    });
    const { isEphemeralPackageRoot } = await import("../../src/install/package-root.mjs");
    const parentAnswer = await withInheritedTmp(root, async () => {
      const answer = layouts.map((layout) => isEphemeralPackageRoot(layout));
      await runTurn();
      return answer;
    });
    expect(parentAnswer).toEqual([true, true, true, false]);
    expect(childAnswer).toEqual(parentAnswer);
  } finally {
    await removePath(root);
  }
});

// Usefulness: verifies the installer refusal holds when an inherited temporary directory holds the
// platform list delimiter, in a child turn and in a turn nested inside it, so the inherited list
// cannot split a valid path and accept an inherited launcher.
test("a delimiter in an inherited temporary path keeps the installer refusal in nested turns", async () => {
  const root = await mkdtemp(join(tmpdir(), `codex${delimiter}tmp-`));
  const saved = Object.fromEntries(
    ["TMPDIR", "TEMP", "TMP", "AGENT_LOOP_INHERITED_TMPDIR"].map((n) => [n, process.env[n]]),
  );
  try {
    const layout = (base) => join(base, "xfs-abc123", "dlx-4242", "node_modules", "pkg");
    const classify = async (env, layouts) =>
      JSON.parse(
        (
          await execa(process.execPath, ["--input-type=module", "-e", CLASSIFY_ROOTS(layouts)], {
            env,
          })
        ).stdout,
      );
    const answers = {};
    fakeCodex(async (home, env) => {
      answers.outer = await classify(env, [layout(root)]);
      // The nested turn runs in a process that inherited the environment of the outer turn.
      Object.assign(process.env, env);
      fakeCodex(async (_nestedHome, nestedEnv) => {
        answers.nested = await classify(nestedEnv, [layout(root), layout(home)]);
        return { stdout: OK_EVENTS, stderr: "" };
      });
      await runTurn();
      return { stdout: OK_EVENTS, stderr: "" };
    });
    await withInheritedTmp(root, () => runTurn());
    expect(answers).toEqual({ outer: [true], nested: [true, true] });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await removePath(root);
  }
});

const INHERITED = "AGENT_LOOP_INHERITED_TMPDIR";
const yarnLayout = (base) => join(base, "xfs-abc123", "dlx-4242", "node_modules", "pkg");

// Every shape of the inherited-list value that a process can hold before a Codex turn. `build`
// returns the raw value (undefined: absent) and the directories that the installer must refuse as
// ancestors. `invalid` marks a value that is present but not a valid list of absolute paths, which
// makes the installer refuse every root.
const INHERITED_SHAPES = [
  ["absent", async () => ({ raw: undefined, ancestors: [] })],
  ["an empty string", async () => ({ raw: "", ancestors: [], invalid: true })],
  ["malformed JSON", async () => ({ raw: "{oops", ancestors: [], invalid: true })],
  ["a JSON non-array", async () => ({ raw: '{"a":1}', ancestors: [], invalid: true })],
  ["an array with a non-string entry", async () => ({ raw: "[1]", ancestors: [], invalid: true })],
  ["an array with an empty entry", async () => ({ raw: '[""]', ancestors: [], invalid: true })],
  ["an empty array", async () => ({ raw: "[]", ancestors: [] })],
  [
    "a relative entry",
    async () => ({
      raw: JSON.stringify(["rel-ancestor"]),
      ancestors: [resolve("rel-ancestor")],
      // The installer refuses a relative entry that it reads itself. A turn resolves it first.
      directlyInvalid: true,
    }),
  ],
  [
    "a link entry",
    async (base) => {
      // A canonical spelling, because the installer compares the real path of an entry.
      const real = join(await realpath(base), "real-ancestor");
      const link = join(base, "link-ancestor");
      await mkdir(real);
      await symlinkOrSkip({ skip: () => {} }, real, link, "junction");
      return { raw: JSON.stringify([link]), ancestors: [link, real] };
    },
  ],
  [
    "an entry with the platform delimiter",
    async (base) => {
      const dir = join(base, `a${delimiter}b`);
      await mkdir(dir);
      return { raw: JSON.stringify([dir]), ancestors: [dir] };
    },
  ],
  [
    "an outer value inherited by a nested turn",
    async (base) => ({
      raw: JSON.stringify([join(base, "outer")]),
      ancestors: [join(base, "outer")],
    }),
  ],
];

// Usefulness: verifies the installer refuses every root that it refuses outside a turn, for every
// shape of the inherited list, in a child turn and in a nested turn. A malformed value fails
// closed, and a relative entry gets one meaning for every child working directory.
test.each(INHERITED_SHAPES)("the installer refusal holds for %s", async (_name, build) => {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  const other = join(root, "other-cwd");
  const saved = Object.fromEntries(
    ["TMPDIR", "TEMP", "TMP", INHERITED].map((name) => [name, process.env[name]]),
  );
  try {
    await mkdir(other);
    const { raw, ancestors, invalid = false, directlyInvalid = invalid } = await build(root);
    const unrelated = join(root, "unrelated");
    const layouts = [root, ...ancestors, unrelated].map(yarnLayout);
    const stable = join(root, "stable", "node_modules", "pkg");
    await mkdir(stable, { recursive: true });
    layouts.push(stable);
    const expected = layouts.map((_, i) => (invalid ? true : i <= ancestors.length));
    const classify = async (env) =>
      JSON.parse(
        (
          await execa(process.execPath, ["--input-type=module", "-e", CLASSIFY_ROOTS(layouts)], {
            env,
            cwd: other,
          })
        ).stdout,
      );
    const seen = {};
    fakeCodex(async (home, env) => {
      seen.childEnv = env;
      seen.child = await classify(env);
      // The nested turn runs in a process that inherited the environment of the outer turn.
      Object.assign(process.env, env);
      fakeCodex(async (_nestedHome, nestedEnv) => {
        seen.nested = await classify(nestedEnv);
        return { stdout: OK_EVENTS, stderr: "" };
      });
      await runTurn();
      return { stdout: OK_EVENTS, stderr: "" };
    });
    await withInheritedTmp(root, async () => {
      if (raw === undefined) delete process.env[INHERITED];
      else process.env[INHERITED] = raw;
      seen.direct = await classify({ ...process.env });
      await runTurn();
    });
    expect(seen.direct.at(-1)).toBe(directlyInvalid);
    expect(seen.child).toEqual(expected);
    expect(seen.nested).toEqual(expected);
    // A bad value is never forwarded as it came, and a path never goes on relative.
    if (raw !== undefined && (invalid || raw.includes("rel-ancestor"))) {
      expect(seen.childEnv[INHERITED]).not.toBe(raw);
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await removePath(root);
  }
});
