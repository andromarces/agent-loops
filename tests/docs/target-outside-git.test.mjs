import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { removePath } from "../fs-helpers.mjs";

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
// reviewed executable mode or the umask default, and that the delivery check rejects a wrong
// executable bit (issue #1571). No other test runs the documented block, so a regression in its
// mode handling or in the check would reach an operator's target.
test.skipIf(!hasBash)(
  "the copy-back keeps target modes and the delivery check compares the executable bit",
  async () => {
    const doc = await readFile(docPath, "utf8");
    const copyBack = bashBlockAfter(doc, 'REPO="<throwaway repository>"');
    const delivery = bashBlockAfter(doc, 'git -C "<throwaway repository>" rev-parse');

    const base = await mkdtemp(join(tmpdir(), "target-outside-git-"));
    try {
      const git = (args) => execa("git", args, { cwd: base });
      await git(["init", "-q", "repo"]);
      await git(["-C", "repo", "config", "core.autocrlf", "false"]);
      await git(["-C", "repo", "config", "user.name", "Tester"]);
      await git(["-C", "repo", "config", "user.email", "test@example.com"]);
      await writeFile(join(base, "repo", ".git", "info", "attributes"), "* -text\n");
      await writeFile(join(base, "repo", "modified.txt"), "modified before\n");
      await writeFile(join(base, "repo", "modified-exec.txt"), "exec before\n");
      await git(["-C", "repo", "add", "--", "modified.txt", "modified-exec.txt"]);
      await git(["-C", "repo", "update-index", "--chmod=+x", "--", "modified-exec.txt"]);
      await git(["-C", "repo", "commit", "-q", "-m", "import"]);
      const imported = (await git(["-C", "repo", "rev-parse", "HEAD"])).stdout.trim();

      await writeFile(join(base, "repo", "modified.txt"), "modified after\n");
      await writeFile(join(base, "repo", "modified-exec.txt"), "exec after\n");
      await mkdir(join(base, "repo", "sub"));
      await writeFile(join(base, "repo", "sub", "added-exec.txt"), "added exec\n");
      await writeFile(join(base, "repo", "sub", "added-plain.txt"), "added plain\n");
      await git([
        "-C",
        "repo",
        "add",
        "--",
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
      await git([
        "-C",
        "repo",
        "update-index",
        "--chmod=-x",
        "--",
        "modified.txt",
        "sub/added-plain.txt",
      ]);
      await git(["-C", "repo", "commit", "-q", "-m", "reviewed"]);
      const reviewed = (await git(["-C", "repo", "rev-parse", "HEAD"])).stdout.trim();

      await writeFile(join(base, "modified.txt"), "modified before\n");
      await chmod(join(base, "modified.txt"), 0o640);
      await writeFile(join(base, "modified-exec.txt"), "exec before\n");
      if (!isWindows) await chmod(join(base, "modified-exec.txt"), 0o755);
      const original = (await git(["hash-object", "--no-filters", "--", "modified.txt"])).stdout;
      const originalExec = (await git(["hash-object", "--no-filters", "--", "modified-exec.txt"]))
        .stdout;

      const render = (block, values) =>
        block
          .replaceAll("<throwaway repository>", "repo")
          .replaceAll("<import commit>", imported)
          .replaceAll("<reviewed.head>", reviewed)
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
      if (!isWindows) {
        const item = cases.find((entry) => entry.label === "modified executable");
        script += `chmod u-x,go-x -- modified-exec.txt
(
${render(delivery, item)}
)
delivery_status=$?
[ "$delivery_status" -eq 1 ] || {
  echo "delivery check exited $delivery_status with a wrong executable bit" >&2
  exit 1
}
`;
      }

      const run = await execa("bash", ["-c", script], { cwd: base, reject: false, all: true });
      expect(run.exitCode, run.all).toBe(0);

      for (const item of cases) {
        const blob = (
          await git(["-C", "repo", "rev-parse", `${reviewed}:${item.file}`])
        ).stdout.trim();
        const delivered = (
          await git(["hash-object", "--no-filters", "--", item.target])
        ).stdout.trim();
        expect(delivered, `${item.label} content`).toBe(blob);
        if (!isWindows) {
          expect((await stat(join(base, item.target))).mode & 0o777, item.label).toBe(item.mode);
        }
      }
    } finally {
      await removePath(base);
    }
  },
);
