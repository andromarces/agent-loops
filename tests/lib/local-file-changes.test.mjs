import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for every case, so no `git` process runs. Any other call reaches the
// real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: async (command, args, options) => {
      const answer =
        gitDouble.answer && command === "git"
          ? await gitDouble.answer(command, args, options)
          : undefined;
      return answer ?? real.execa(command, args, options);
    },
  };
});

import {
  findDifferingLocalFiles,
  findLocalFileChanges,
  hashCopiedLocalFiles,
  refreshLocalFile,
} from "../../src/lib/local-file-changes.mjs";
import { removePath } from "../fs-helpers.mjs";

const created = [];

afterEach(async () => {
  gitDouble.answer = null;
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    await removePath(dir);
  }
});

// Two plain directories, `main` with a `.git` directory, for a test of the file comparison. The
// comparison reads only file bytes once Git has named the two work trees. The double names them in
// the `--porcelain -z` format, so no `git` process runs. Any other `git` call throws.
async function createComparePair() {
  const base = await mkdtemp(join(tmpdir(), "compare-test-"));
  created.push(base);
  const main = join(base, "main");
  const linked = join(base, "linked");
  await mkdir(join(main, ".git"), { recursive: true });
  await mkdir(linked);
  const head = "1".repeat(40);
  gitDouble.answer = (_command, args, options) => {
    const answer = (stdout) => ({ exitCode: 0, stdout, stderr: "" });
    switch (JSON.stringify(args)) {
      case '["rev-parse","--show-toplevel"]':
        return answer(`${options.cwd}\n`);
      case '["rev-parse","--git-common-dir"]':
        return answer(`${join(main, ".git")}\n`);
      case '["worktree","list","--porcelain","-z"]':
        return answer(
          `worktree ${main}\0HEAD ${head}\0branch refs/heads/main\0\0` +
            `worktree ${linked}\0HEAD ${head}\0branch refs/heads/run\0\0`,
        );
      default:
        throw new Error(`unexpected git call: ${JSON.stringify(args)}`);
    }
  };
  return { base, main, linked };
}

// Usefulness: verifies a link on the main work tree side is never read through, so equal bytes do
// not hide a difference. The link is a junction on Windows and a symlink elsewhere.
// Not redundant: the other comparison tests use real directories only.
test("a linked parent directory in the main work tree is reported and not read through", async () => {
  const { main, linked, base } = await createComparePair();
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "settings.json"), "same\n");
  await symlink(outside, join(main, ".claude"), "junction");
  await mkdir(join(linked, ".claude"));
  await writeFile(join(linked, ".claude", "settings.json"), "same\n");

  expect(await findDifferingLocalFiles(linked, [".claude/settings.json"])).toEqual([
    ".claude/settings.json",
  ]);
});

// Usefulness: verifies the same guard on the run work tree side.
// Not redundant: it covers the second root that the comparison reads from.
test("a linked parent directory in the run work tree is reported and not read through", async () => {
  const { main, linked, base } = await createComparePair();
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "settings.json"), "same\n");
  await mkdir(join(main, ".claude"));
  await writeFile(join(main, ".claude", "settings.json"), "same\n");
  await symlink(outside, join(linked, ".claude"), "junction");

  expect(await findDifferingLocalFiles(linked, [".claude/settings.json"])).toEqual([
    ".claude/settings.json",
  ]);
});

// Usefulness: verifies two different files over the 1 MiB cap are reported, because a skipped
// comparison is not an equal hash.
// Not redundant: the other comparison tests use small files.
test("two different files over the size cap are reported as differing", async () => {
  const { main, linked } = await createComparePair();
  const size = 1024 * 1024 + 1;
  await writeFile(join(main, ".env"), Buffer.alloc(size, "a"));
  await writeFile(join(linked, ".env"), Buffer.alloc(size, "b"));

  expect(await findDifferingLocalFiles(linked, [".env"])).toEqual([".env"]);
});

// Usefulness: verifies a name that is missing from both work trees is not reported.
// Not redundant: it keeps the missing-on-both-sides case apart from a skipped comparison.
test("a name missing from both work trees is not reported", async () => {
  const { linked } = await createComparePair();

  expect(await findDifferingLocalFiles(linked, [".env"])).toEqual([]);
});

// Usefulness: verifies the fail-closed cases of issue #1501: a legacy or malformed init hash
// and a missing side never report no change.
// Not redundant: the role tests cover the three proven sides and the unchanged case only.
test("the side-aware compare fails closed on a missing hash or a missing file", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "same\n");
  await writeFile(join(linked, ".env"), "same\n");
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);
  expect(typeof baseline[".env"]).toBe("string");

  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([]);
  expect(await findLocalFileChanges(linked, [".env"], undefined)).toEqual([
    { path: ".env", changed: "unknown" },
  ]);
  expect(await findLocalFileChanges(linked, [".env"], { ".env": "not-a-hash" })).toEqual([
    { path: ".env", changed: "unknown" },
  ]);

  await rm(join(linked, ".env"));
  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([
    { path: ".env", changed: "copy" },
  ]);
  await writeFile(join(linked, ".env"), "same\n");
  await rm(join(main, ".env"));
  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([
    { path: ".env", changed: "source" },
  ]);
  await rm(join(linked, ".env"));
  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([
    { path: ".env", changed: "both" },
  ]);
});

// Usefulness: verifies a source save between the read and the write cannot mix bytes.
// Not redundant: it is the only refresh test that changes the source during the call.
test("a source save between the read and the write leaves the read bytes and reports source", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "KEY=OLD\n");
  await writeFile(join(linked, ".env"), "KEY=OLD\n");
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);
  let saved = false;

  const hash = await refreshLocalFile(linked, ".env", {
    expectedCopyHash: baseline[".env"],
    beforeWrite: async () => {
      saved = true;
      await writeFile(join(main, ".env"), "KEY=NEW\n");
    },
  });

  expect(saved).toBe(true);
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("KEY=OLD\n");
  expect(hash === baseline[".env"]).toBe(true);
  expect(await readdir(linked)).toEqual([".env"]);
  expect(await findLocalFileChanges(linked, [".env"], { ".env": hash })).toEqual([
    { path: ".env", changed: "source" },
  ]);
});

// Usefulness: verifies a refresh keeps the copy's private mode, so no wider access appears.
// Not redundant: it is the only test that checks the mode after a refresh.
// Windows does not expose POSIX mode bits, so the mode check is POSIX only.
test.skipIf(process.platform === "win32")("a refresh keeps the mode of a 0600 copy", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "KEY=OLD\n");
  await writeFile(join(linked, ".env"), "KEY=OLD\n");
  await chmod(join(linked, ".env"), 0o600);
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);

  await refreshLocalFile(linked, ".env", { expectedCopyHash: baseline[".env"] });

  expect((await stat(join(linked, ".env"))).mode & 0o777).toBe(0o600);
});

// Usefulness: verifies a refresh keeps a wider copy mode, so the mode follows the copy.
// Not redundant: the 0600 test passes when the temporary file alone sets the mode.
// Windows does not expose POSIX mode bits, so the mode check is POSIX only.
test.skipIf(process.platform === "win32")("a refresh keeps a 0640 copy at 0640", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "KEY=OLD\n");
  await writeFile(join(linked, ".env"), "KEY=OLD\n");
  await chmod(join(linked, ".env"), 0o640);
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);

  await refreshLocalFile(linked, ".env", { expectedCopyHash: baseline[".env"] });

  expect((await stat(join(linked, ".env"))).mode & 0o777).toBe(0o640);
});

// Usefulness: verifies a failed exclusive create leaves an entry the command did not make.
// Not redundant: it forces the temporary create to fail on an existing entry.
test("a failed exclusive create leaves the existing temporary entry", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "KEY=OLD\n");
  await writeFile(join(linked, ".env"), "KEY=OLD\n");
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);
  let temp = "";

  await expect(
    refreshLocalFile(linked, ".env", {
      expectedCopyHash: baseline[".env"],
      beforeTempCreate: async (path) => {
        temp = path;
        await writeFile(path, "KEEP\n");
      },
    }),
  ).rejects.toThrow("the copy failed");

  expect(temp === "").toBe(false);
  expect(await readFile(temp, "utf8")).toBe("KEEP\n");
  expect(await readFile(join(linked, ".env"), "utf8")).toBe("KEY=OLD\n");
});

// Usefulness: verifies every later side change is still reported after a refresh.
// Not redundant: it applies all edit and delete combinations to the refreshed hash.
test("a later change on either side is still reported after a refresh", async () => {
  const { main, linked } = await createComparePair();
  const source = join(main, ".env");
  const copy = join(linked, ".env");
  await writeFile(source, "KEY=OLD\n");
  await writeFile(copy, "KEY=OLD\n");
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);
  const hash = await refreshLocalFile(linked, ".env", { expectedCopyHash: baseline[".env"] });
  const restore = async () => {
    await rm(source, { force: true });
    await rm(copy, { force: true });
    await writeFile(source, "KEY=OLD\n");
    await writeFile(copy, "KEY=OLD\n");
  };
  const cases = [
    ["source edit", async () => writeFile(source, "KEY=S\n"), "source"],
    ["source delete", async () => rm(source), "source"],
    ["copy edit", async () => writeFile(copy, "KEY=C\n"), "copy"],
    ["copy delete", async () => rm(copy), "copy"],
    [
      "both edit",
      async () => {
        await writeFile(source, "KEY=S\n");
        await writeFile(copy, "KEY=C\n");
      },
      "both",
    ],
    [
      "both delete",
      async () => {
        await rm(source);
        await rm(copy);
      },
      "both",
    ],
    [
      "source delete and copy edit",
      async () => {
        await rm(source);
        await writeFile(copy, "KEY=C\n");
      },
      "both",
    ],
    [
      "source edit and copy delete",
      async () => {
        await writeFile(source, "KEY=S\n");
        await rm(copy);
      },
      "both",
    ],
  ];
  for (const [name, change, changed] of cases) {
    await restore();
    await change();
    expect(await findLocalFileChanges(linked, [".env"], { ".env": hash }), name).toEqual([
      { path: ".env", changed },
    ]);
  }
});

// Usefulness: verifies that a deleted source and an edited copy report both sides.
// Not redundant: the other deletion tests leave the second side unchanged.
test("a deleted source and an edited copy report both", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "same\n");
  await writeFile(join(linked, ".env"), "same\n");
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);
  await rm(join(main, ".env"));
  await writeFile(join(linked, ".env"), "copy edit\n");

  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([
    { path: ".env", changed: "both" },
  ]);
});

// Usefulness: verifies that an edited source and a deleted copy report both sides.
// Not redundant: it reverses the two changed sides of the test above.
test("an edited source and a deleted copy report both", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "same\n");
  await writeFile(join(linked, ".env"), "same\n");
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);
  await writeFile(join(main, ".env"), "source edit\n");
  await rm(join(linked, ".env"));

  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([
    { path: ".env", changed: "both" },
  ]);
});

// Usefulness: verifies that deleting both sides reports both.
// Not redundant: it covers two deletions together, not a deletion with an edit.
test("a deleted source and a deleted copy report both", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "same\n");
  await writeFile(join(linked, ".env"), "same\n");
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);
  await rm(join(main, ".env"));
  await rm(join(linked, ".env"));

  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([
    { path: ".env", changed: "both" },
  ]);
});

// Usefulness: verifies that one deleted side with an unchanged other side reports that side.
// Not redundant: the both-deleted test checks two deletions, not one.
test("a deleted side with the other side unchanged reports that side", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "same\n");
  await writeFile(join(linked, ".env"), "same\n");
  const baseline = await hashCopiedLocalFiles(linked, [".env"]);

  await rm(join(main, ".env"));
  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([
    { path: ".env", changed: "source" },
  ]);
  await writeFile(join(main, ".env"), "same\n");
  await rm(join(linked, ".env"));
  expect(await findLocalFileChanges(linked, [".env"], baseline)).toEqual([
    { path: ".env", changed: "copy" },
  ]);
});

// Usefulness: verifies an ancestor swapped for a link after the checks is never read through.
// The swap happens before the read, so equal bytes do not hide a difference.
// Not redundant: the static linked-ancestor tests link the directory before the comparison starts.
test("an ancestor swapped for a link before the read is reported and not read through", async () => {
  const { main, linked, base } = await createComparePair();
  // The hooks receive canonical paths, which differ from `main` where the temp dir is a link (macOS).
  const mainReal = await realpath(main);
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "settings.json"), "same\n");
  await mkdir(join(main, ".claude"));
  await writeFile(join(main, ".claude", "settings.json"), "other\n");
  await mkdir(join(linked, ".claude"));
  await writeFile(join(linked, ".claude", "settings.json"), "same\n");
  let swapped = false;

  const differing = await findDifferingLocalFiles(linked, [".claude/settings.json"], {
    beforeRead: async (path) => {
      if (!path.startsWith(mainReal) || swapped) {
        return;
      }
      swapped = true;
      await rename(join(main, ".claude"), join(main, ".claude-real"));
      await symlink(outside, join(main, ".claude"), "junction");
    },
  });

  expect(swapped).toBe(true);
  expect(differing).toEqual([".claude/settings.json"]);
});

// Usefulness: verifies a link inserted after the ancestor check is rejected before the file is opened.
// No read starts on a path outside its work tree root.
// Not redundant: the earlier swap test swaps before the open; this one swaps between the check and the open.
// It also asserts that the open stage is never reached.
test("a link inserted after the ancestor check is rejected before any read starts", async () => {
  const { main, linked, base } = await createComparePair();
  // The hooks receive canonical paths, which differ from `main` where the temp dir is a link (macOS).
  const mainReal = await realpath(main);
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "settings.json"), "same\n");
  await mkdir(join(main, ".claude"));
  await writeFile(join(main, ".claude", "settings.json"), "other\n");
  await mkdir(join(linked, ".claude"));
  await writeFile(join(linked, ".claude", "settings.json"), "same\n");
  let swapped = false;
  const opened = [];

  const differing = await findDifferingLocalFiles(linked, [".claude/settings.json"], {
    afterAncestorCheck: async (path) => {
      if (!path.startsWith(mainReal) || swapped) {
        return;
      }
      swapped = true;
      await rename(join(main, ".claude"), join(main, ".claude-real"));
      await symlink(outside, join(main, ".claude"), "junction");
    },
    beforeRead: async (path) => {
      opened.push(path);
    },
  });

  expect(swapped).toBe(true);
  expect(differing).toEqual([".claude/settings.json"]);
  expect(opened.filter((path) => path.startsWith(mainReal))).toEqual([]);
});

// Usefulness: verifies a file that disappears from both work trees after the first probe is
// reported as not comparable, not as missing from both sides.
// Not redundant: the missing-from-both test removes the file before the comparison starts.
test("a file that disappears after the first probe is reported, not treated as missing", async () => {
  const { main, linked } = await createComparePair();
  await writeFile(join(main, ".env"), "same\n");
  await writeFile(join(linked, ".env"), "same\n");

  const differing = await findDifferingLocalFiles(linked, [".env"], {
    beforeRead: async (path) => {
      await rm(path);
    },
  });

  expect(differing).toEqual([".env"]);
});

// Usefulness: verifies an unchanged file is not reported when `--cwd` is reached through a link to
// its parent. The link has the shape of `/var` and `/private/var` on macOS.
// Not redundant: the other comparison tests use the canonical temp path.
// Not run on Windows, which needs a privilege for a directory symlink.
test.skipIf(process.platform === "win32")(
  "an unchanged file is not reported when --cwd is reached through a linked parent directory",
  async () => {
    const { main, linked, base } = await createComparePair();
    await writeFile(join(main, ".env"), "same\n");
    await writeFile(join(linked, ".env"), "same\n");
    const alias = join(base, "alias");
    await symlink(base, alias);

    expect(await findDifferingLocalFiles(join(alias, "linked"), [".env"])).toEqual([]);
  },
);
