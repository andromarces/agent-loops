import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { exists, removePath } from "../fs-helpers.mjs";

const docPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/orchestrator/target-outside-git.md",
);

/** The bash block that holds `marker`, without the fence. */
function bashBlockAfter(text, marker) {
  const start = text.indexOf(marker);
  expect(start, `no text holds: ${marker}`).toBeGreaterThanOrEqual(0);
  const open = text.lastIndexOf("```bash", start);
  expect(open, `no bash block before: ${marker}`).toBeGreaterThanOrEqual(0);
  const body = open + "```bash".length;
  const end = text.indexOf("```", body);
  expect(end, `no closing fence after: ${marker}`).toBeGreaterThan(body);
  return text.slice(body, end).trim();
}

const isWindows = process.platform === "win32";
const hasBash = await execa("bash", ["-c", "exit 0"], { reject: false }).then(
  (run) => !run.failed,
  () => false,
);

// Usefulness: verifies the copy-back keeps a modified target's mode, gives an added target the
// reviewed executable mode or the umask default, removes a deleted target, and that the delivery
// check rejects a wrong executable bit, a remaining deleted target, an unreadable reviewed
// revision, or a mistyped path (issue #1576). No other test runs the documented blocks, so a
// regression in their handling or in the check would reach an operator's target.
test.skipIf(!hasBash)(
  "the copy-back delivers modified, added, and deleted targets and the delivery check rejects a wrong state",
  async () => {
    const doc = await readFile(docPath, "utf8");
    const copyBack = bashBlockAfter(doc, 'REPO="<throwaway repository>"');
    const delivery = bashBlockAfter(doc, 'MODE=$(git -C "<throwaway repository>" ls-tree');

    const base = await mkdtemp(join(tmpdir(), "target-outside-git-"));
    try {
      const git = (args, options = {}) => execa("git", args, { cwd: base, ...options });
      const gitLines = async (args, input) =>
        (await git(args, { input })).stdout.trim().split("\n");
      await git(["init", "-q", "repo"]);
      const configPath = join(base, "repo", ".git", "config");
      await writeFile(
        configPath,
        `${await readFile(configPath, "utf8")}[core]\n\tautocrlf = false\n[user]\n\tname = Tester\n\temail = test@example.com\n`,
      );
      await writeFile(join(base, "repo", ".git", "info", "attributes"), "* -text\n");
      await writeFile(join(base, "repo", "modified.txt"), "modified before\n");
      await writeFile(join(base, "repo", "modified-exec.txt"), "exec before\n");
      await writeFile(join(base, "repo", "deleted.txt"), "deleted before\n");
      await git(["-C", "repo", "add", "--", "modified.txt", "modified-exec.txt", "deleted.txt"]);
      await git(["-C", "repo", "update-index", "--chmod=+x", "--", "modified-exec.txt"]);
      await git(["-C", "repo", "commit", "-q", "-m", "import"]);

      await writeFile(join(base, "repo", "modified.txt"), "modified after\n");
      await writeFile(join(base, "repo", "modified-exec.txt"), "exec after\n");
      await mkdir(join(base, "repo", "sub"));
      await writeFile(join(base, "repo", "sub", "added-exec.txt"), "added exec\n");
      await writeFile(join(base, "repo", "sub", "added-plain.txt"), "added plain\n");
      await rm(join(base, "repo", "deleted.txt"));
      await git([
        "-C",
        "repo",
        "add",
        "--all",
        "--",
        "deleted.txt",
        "modified.txt",
        "modified-exec.txt",
        "sub/added-exec.txt",
        "sub/added-plain.txt",
      ]);
      await git([
        "-C",
        "repo",
        "update-index",
        "--chmod=+x",
        "--",
        "modified-exec.txt",
        "sub/added-exec.txt",
      ]);
      await git(["-C", "repo", "commit", "-q", "-m", "reviewed"]);
      const [reviewed, imported] = await gitLines(["-C", "repo", "rev-parse", "HEAD", "HEAD^"]);

      await writeFile(join(base, "modified.txt"), "modified before\n");
      await chmod(join(base, "modified.txt"), 0o640);
      await writeFile(join(base, "modified-exec.txt"), "exec before\n");
      if (!isWindows) await chmod(join(base, "modified-exec.txt"), 0o755);
      await writeFile(join(base, "deleted.txt"), "deleted before\n");
      const [original, originalExec, originalDeleted] = await gitLines(
        ["hash-object", "--no-filters", "--stdin-paths"],
        "modified.txt\nmodified-exec.txt\ndeleted.txt\n",
      );

      const render = (block, values) =>
        block
          .replaceAll("<throwaway repository>", "repo")
          .replaceAll("<import commit>", imported)
          .replaceAll("<reviewed.head>", values.reviewed ?? reviewed)
          .replaceAll("<path>", values.file)
          .replaceAll("<target>", values.target)
          .replaceAll("<original hash>", values.original);

      const cases = [
        {
          label: "modified",
          file: "modified.txt",
          target: "modified.txt",
          original,
          mode: 0o640,
        },
        {
          label: "added plain",
          file: "sub/added-plain.txt",
          target: "sub/added-plain.txt",
          original: "",
          mode: 0o644,
        },
      ];
      if (!isWindows) {
        cases.push(
          {
            label: "modified executable",
            file: "modified-exec.txt",
            target: "modified-exec.txt",
            original: originalExec,
            mode: 0o755,
          },
          {
            label: "added executable",
            file: "sub/added-exec.txt",
            target: "sub/added-exec.txt",
            original: "",
            mode: 0o755,
          },
        );
      }

      let script = "umask 022\n";
      for (const item of cases) {
        script += `(
${render(copyBack, item)}
)
copy_back_status=$?
[ "$copy_back_status" -eq 0 ] || {
  echo "copy-back failed for ${item.label}" >&2
  exit "$copy_back_status"
}
(
${render(delivery, item)}
) || {
  echo "delivery check failed for ${item.label}" >&2
  exit 1
}
`;
      }
      const deleted = {
        file: "deleted.txt",
        target: "deleted.txt",
        original: originalDeleted,
      };
      script += `(
${render(copyBack, deleted)}
)
copy_back_status=$?
[ "$copy_back_status" -eq 0 ] || {
  echo "copy-back failed for the deleted target" >&2
  exit "$copy_back_status"
}
(
${render(delivery, deleted)}
) || {
  echo "delivery check failed for the deleted target" >&2
  exit 1
}
printf 'remaining\n' > deleted.txt
(
${render(delivery, deleted)}
)
delivery_status=$?
rm -f deleted.txt
[ "$delivery_status" -eq 1 ] || {
  echo "delivery check exited $delivery_status with a remaining deleted target" >&2
  exit 1
}
`;
      const rejected = [
        {
          label: "unreadable revision",
          file: "deleted.txt",
          target: "deleted.txt",
          original: originalDeleted,
          reviewed: "0".repeat(40),
        },
        {
          label: "mistyped path",
          file: "missing.txt",
          target: "deleted.txt",
          original: "",
        },
      ];
      for (const item of rejected) {
        script += `(
${render(delivery, item)}
)
delivery_status=$?
[ "$delivery_status" -eq 1 ] || {
  echo "delivery check exited $delivery_status for the ${item.label}" >&2
  exit 1
}
`;
      }
      const negative = {
        file: "modified-exec.txt",
        target: "modified.txt",
        original: originalExec,
      };
      script += `(
${render(delivery, negative)}
)
delivery_status=$?
[ "$delivery_status" -eq 1 ] || {
  echo "delivery check exited $delivery_status with a wrong executable bit" >&2
  exit 1
}
`;

      await writeFile(join(base, "run.sh"), script);
      const run = await execa("bash", ["run.sh"], { cwd: base, reject: false, all: true });
      expect(run.exitCode, run.all).toBe(0);

      const blobs = await gitLines([
        "-C",
        "repo",
        "rev-parse",
        ...cases.map((item) => `${reviewed}:${item.file}`),
      ]);
      const delivered = await gitLines(
        ["hash-object", "--no-filters", "--stdin-paths"],
        `${cases.map((item) => item.target).join("\n")}\n`,
      );
      for (const [index, item] of cases.entries()) {
        expect(delivered[index], `${item.label} content`).toBe(blobs[index]);
        if (!isWindows) {
          expect((await stat(join(base, item.target))).mode & 0o777, item.label).toBe(item.mode);
        }
      }
      expect(await exists(join(base, deleted.target)), "deleted target").toBe(false);
    } finally {
      await removePath(base);
    }
  },
);
