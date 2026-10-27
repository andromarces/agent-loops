import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import { pageStdout } from "../runtime-helpers.mjs";
import { fakeClock, HEAD_A, HEAD_B, scriptedGh } from "./check-wait-helpers.mjs";

// The `--all` wait's no-check-source early return (issue #1054). After the PR head itself showed no
// check run and no commit status, the probe pins the base SHA, then reads the files of the PR, the
// workflow files at that SHA, and the check runs and commit statuses of the base head. A failed,
// unparseable, unvalidated, incomplete, or moved read keeps the normal wait, so the helper fails one
// endpoint on demand.
const BASE_HEAD = "c".repeat(40);
const OTHER_BASE_HEAD = "d".repeat(40);
const NO_CHECKS_YET = {
  status: 1,
  stdout: "",
  checks: [],
  stderr: "no checks reported on the 'main' branch",
};
const readOk = (body) => ({ status: 0, stdout: pageStdout(body), stderr: "", timedOut: false });
const PROBE_NOT_FOUND = {
  status: 1,
  stdout: 'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}',
  stderr: "gh: Not Found (HTTP 404)",
  timedOut: false,
};
const INERT_WORKFLOW =
  "name: nightly\non:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'\n";
const BASE_RUN = {
  id: 1,
  name: "app-ci",
  status: "completed",
  conclusion: "success",
  started_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T00:01:00Z",
};
const BASE_STATUS = {
  id: 1,
  context: "ci/external",
  state: "success",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const PENDING_STATUS = { ...BASE_STATUS, id: 9, state: "pending" };
const MERGED_HEAD = "e".repeat(40);
const TIED_HEAD = "f".repeat(40);
const MERGED_PR = {
  number: 7,
  merged_at: "2026-01-01T00:00:00Z",
  base: { ref: "main" },
  head: { sha: MERGED_HEAD },
};

/** A workflow file reply as the contents API sends it: base64 with a line break every 60 characters. */
function fileReply(text, over = {}) {
  const bytes = Buffer.from(text);
  return {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64").replace(/(.{60})/g, "$1\n"),
    ...over,
  };
}

const http = (status, body, headers = "") =>
  `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n${headers}\r\n${typeof body === "string" ? body : JSON.stringify(body)}`;

/** A scripted `gh` for a PR with no check yet, plus the probe reads, each overridable or failing by endpoint prefix. */
function probeGh({
  prFiles = [{ filename: "README.md" }],
  workflows = { "nightly.yml": INERT_WORKFLOW },
  baseRuns = [],
  baseStatuses = [],
  mergedPrs = [],
  mergedRuns = [],
  mergedStatuses = [],
  tiedRuns = [],
  failing = null,
  reply = null,
  files = null,
  listing = null,
  baseShas = [BASE_HEAD],
  headItems = [],
  headStatuses = [],
  heads = [HEAD_A],
  all = true,
} = {}) {
  const inner = scriptedGh([NO_CHECKS_YET], {
    all,
    heads,
    commits: { [HEAD_A]: headItems },
    statuses: headStatuses,
  });
  const repo = "repos/owner/repo";
  let baseReads = 0;
  return async (args, cwd) => {
    const endpoint = args[0] === "api" ? args[1] : "";
    if (failing !== null && endpoint.startsWith(`${repo}/${failing}`)) {
      return { status: 1, stdout: "", stderr: "gh: Internal failure (HTTP 500)", timedOut: false };
    }
    if (reply !== null && endpoint.startsWith(`${repo}/${reply.endpoint}`)) {
      return reply.result;
    }
    const filesPage = /^repos\/owner\/repo\/pulls\/42\/files\?per_page=(\d+)&page=(\d+)$/.exec(
      endpoint,
    );
    if (filesPage) {
      const [size, page] = [Number(filesPage[1]), Number(filesPage[2])];
      return readOk(prFiles.slice((page - 1) * size, page * size));
    }
    if (endpoint === `${repo}/commits/main`) {
      return readOk({ sha: baseShas[Math.min(baseReads++, baseShas.length - 1)] });
    }
    if (endpoint === `${repo}/contents/.github/workflows?ref=${BASE_HEAD}`) {
      if (listing !== null) {
        return listing;
      }
      return workflows === null
        ? PROBE_NOT_FOUND
        : readOk(
            Object.keys(workflows).map((name) => ({
              name,
              path: `.github/workflows/${name}`,
              type: "file",
            })),
          );
    }
    const file =
      /^repos\/owner\/repo\/contents\/\.github\/workflows\/([^?]+)\?ref=([0-9a-f]+)$/.exec(
        endpoint,
      );
    if (file && file[2] === BASE_HEAD) {
      return readOk(files ?? fileReply(workflows[file[1]]));
    }
    if (endpoint.startsWith(`${repo}/commits/${BASE_HEAD}/check-runs`)) {
      return readOk({ total_count: baseRuns.length, check_runs: baseRuns });
    }
    if (endpoint.startsWith(`${repo}/commits/${BASE_HEAD}/status`)) {
      return readOk({ total_count: baseStatuses.length, statuses: baseStatuses });
    }
    if (endpoint.startsWith(`${repo}/commits/${BASE_HEAD}/pulls`)) {
      return readOk(mergedPrs);
    }
    if (endpoint.startsWith(`${repo}/commits/${MERGED_HEAD}/check-runs`)) {
      return readOk({ total_count: mergedRuns.length, check_runs: mergedRuns });
    }
    if (endpoint.startsWith(`${repo}/commits/${TIED_HEAD}/check-runs`)) {
      return readOk({ total_count: tiedRuns.length, check_runs: tiedRuns });
    }
    if (endpoint.startsWith(`${repo}/commits/${TIED_HEAD}/status`)) {
      return readOk({ total_count: 0, statuses: [] });
    }
    if (endpoint.startsWith(`${repo}/commits/${MERGED_HEAD}/status`)) {
      return readOk({ total_count: mergedStatuses.length, statuses: mergedStatuses });
    }
    return inner(args, cwd);
  };
}

function probedWait(options = {}, extra = {}) {
  const clock = fakeClock();
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    all: true,
    gh: probeGh(options),
    now: clock.now,
    sleep: clock.sleep,
    ...extra,
  }).then((result) => ({ result, elapsed: clock.elapsed() }));
}

// Usefulness: verifies the `--all` wait returns at once with `noCheckSource`, no timeout, and an
// empty `checks` when the PR head shows no check, the PR changes no workflow file, the base workflows
// hold no trigger that runs for the PR head, and the base head has no check run or commit status
// (issue #1054). A parent then skips the full bound without reading any workflow itself.
test("the --all wait returns noCheckSource at once when no source can report a check", async () => {
  const { result, elapsed } = await probedWait();
  expect(result).toEqual({ timedOut: false, noCheckSource: true, head: HEAD_A, checks: [] });
  expect(elapsed).toBe(0);
});

// Usefulness: verifies a base branch with no workflow directory counts as no workflow, so a
// repository with no CI at all skips the wait (issue #1054).
test("the --all wait returns noCheckSource when the base branch has no workflow directory", async () => {
  const { result } = await probedWait({ workflows: null });
  expect(result).toEqual({ timedOut: false, noCheckSource: true, head: HEAD_A, checks: [] });
});

// Usefulness: verifies the wait skips on a PR of 2,999 files, one under the cap of the files
// endpoint, so the cap rule below is not a blanket refusal of a large PR (issue #1054).
test("the --all wait returns noCheckSource for a PR just under the file cap", async () => {
  const prFiles = Array.from({ length: 2999 }, (_, i) => ({ filename: `src/f${i}.js` }));
  const { result } = await probedWait({ prFiles });
  expect(result.noCheckSource).toBe(true);
});

// Usefulness: verifies an empty workflow file, which decodes to zero bytes with a matching size, is
// valid evidence of no trigger (issue #1054), so the validation does not reject a real empty file.
test("the --all wait accepts an empty workflow file with a matching size", async () => {
  const { result } = await probedWait({ files: fileReply("") });
  expect(result.noCheckSource).toBe(true);
});

const TRIGGERS = [
  "pull_request",
  "pull_request_target",
  "push",
  "merge_group",
  "workflow_run",
  "check_suite",
];

// Usefulness: verifies each condition and each failed read that keeps the normal wait: the wait
// runs to the bound with `timedOut: true`, an empty `checks`, and no `noCheckSource` (issue #1054).
// One row per condition, so a dropped condition fails its own row.
test.each([
  ["a PR file under .github/workflows", { prFiles: [{ filename: ".github/workflows/ci.yml" }] }],
  [
    "a PR file renamed out of .github/workflows",
    { prFiles: [{ filename: "ci.yml", previous_filename: ".github/workflows/ci.yml" }] },
  ],
  ...TRIGGERS.map((trigger) => [
    `a base workflow with a ${trigger} trigger`,
    { workflows: { "ci.yml": `on:\n  ${trigger}:\n    branches: [main]\n` } },
  ]),
  ["a base workflow with an inline trigger list", { workflows: { "ci.yml": "on: [push]\n" } }],
  ["a check run on the base head", { baseRuns: [BASE_RUN] }],
  ["a commit status on the base head", { baseStatuses: [BASE_STATUS] }],
  ["a failed PR files read", { failing: "pulls/42/files" }],
  ["a failed workflow listing read", { failing: "contents/.github/workflows?" }],
  ["a failed workflow file read", { failing: "contents/.github/workflows/nightly.yml" }],
  ["a failed base head read", { failing: "commits/main" }],
  ["a failed base head check-runs read", { failing: `commits/${BASE_HEAD}/check-runs` }],
  ["a failed base head status read", { failing: `commits/${BASE_HEAD}/status` }],
])("the --all wait keeps the normal wait for %s", async (_name, options) => {
  const { result } = await probedWait(options);
  expect(result.noCheckSource).toBeUndefined();
  expect(result).toMatchObject({ timedOut: true, checks: [] });
});

const FILTERED = (events) => `name: ci\non:\n${events}\njobs:\n  t:\n    runs-on: ubuntu-latest\n`;
const PR_PATHS = (...patterns) =>
  FILTERED(`  pull_request:\n    paths:\n${patterns.map((p) => `      - ${p}`).join("\n")}`);

// Usefulness: verifies a base workflow that only names path-filtered PR events, with no PR file
// matching any pattern, counts as unable to report, so the wait ends at once (issue #1065). One row
// per accepted shape, so a dropped shape fails its own row.
test.each([
  ["the workflow filter of the issue", PR_PATHS(".github/workflows/**", ".github/actionlint.yaml")],
  ["a quoted pattern and a trailing comment", PR_PATHS("'src/**'  # code", '"lib/*.js"')],
  [
    "pull_request_target with paths",
    FILTERED("  pull_request_target:\n    paths:\n      - 'src/**'"),
  ],
  [
    "both PR events with paths and a branch filter",
    FILTERED(
      "  pull_request:\n    branches: [main]\n    paths:\n      - src/**\n" +
        "  pull_request_target:\n    paths:\n      - src/**",
    ),
  ],
  ["a flow list of paths", FILTERED("  pull_request:\n    paths: [src/**, 'docs/*.md']")],
  ["a quoted on key", PR_PATHS("src/**").replace("on:", '"on":')],
  [
    "a flow map and a block scalar holding trigger text in the jobs",
    `${PR_PATHS("src/**")}  s:\n    env: { A: b }\n    steps:\n      - run: |\n          on:\n            push:\n`,
  ],
  [
    "a list at the indent of its key",
    FILTERED("  pull_request:\n    paths:\n    - src/**\n    - docs/*.md"),
  ],
])(
  "the --all wait returns noCheckSource for a path-filtered workflow with %s",
  async (_n, text) => {
    const { result, elapsed } = await probedWait({ workflows: { "ci.yml": text } });
    expect(result).toEqual({ timedOut: false, noCheckSource: true, head: HEAD_A, checks: [] });
    expect(elapsed).toBe(0);
  },
);

const MANY_FILES = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}` }));

// Usefulness: verifies each case that keeps the wait for a path-filtered workflow (issue #1065): a
// PR file that matches a pattern, a rename whose old name matches, a `paths-ignore` filter, a
// pattern the matcher cannot settle, another event, a PR event with no `paths`, and a text that
// does not read as plain block YAML. One row per case, so a dropped rule fails its own row.
test.each([
  ["a PR file that matches a pattern", PR_PATHS("README.md"), {}],
  ["a PR file that matches a ** pattern", PR_PATHS("**.md"), {}],
  ["a PR file that matches a **/ pattern at the root", PR_PATHS("**/*.md"), {}],
  [
    "a PR file under a literal directory pattern",
    PR_PATHS("docs"),
    { prFiles: [{ filename: "docs/a.md" }] },
  ],
  [
    "a PR file renamed out of a matching path",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "README.md", previous_filename: "src/a.js" }] },
  ],
  ["a ! negation pattern", PR_PATHS("'src/**'", "'!src/x.js'"), {}],
  ["a character class pattern", PR_PATHS("'src/[ab].js'"), {}],
  ["a ? pattern", PR_PATHS("'src/a?.js'"), {}],
  ["a pattern that is a YAML alias", PR_PATHS("*.js"), {}],
  [
    "a push event beside the filtered PR event",
    FILTERED("  push:\n  pull_request:\n    paths:\n      - src/**"),
    {},
  ],
  [
    "a workflow_dispatch event beside the filtered PR event",
    FILTERED("  workflow_dispatch:\n  pull_request:\n    paths:\n      - src/**"),
    {},
  ],
  ["paths-ignore", FILTERED("  pull_request:\n    paths-ignore:\n      - README.md"), {}],
  [
    "paths and paths-ignore",
    FILTERED("  pull_request:\n    paths:\n      - src/**\n    paths-ignore:\n      - a"),
    {},
  ],
  ["a PR event with no paths", FILTERED("  pull_request:\n    branches: [main]"), {}],
  [
    "one PR event with paths and one without",
    FILTERED(
      "  pull_request:\n    paths:\n      - src/**\n  pull_request_target:\n    branches: [main]",
    ),
    {},
  ],
  ["an empty paths list", FILTERED("  pull_request:\n    paths:"), {}],
  ["a scalar on", "on: pull_request\n", {}],
  ["a later unclosed flow list", `${PR_PATHS("src/**")}jobs: [\n`, {}],
  [
    "an unterminated flow list in the event",
    "on:\n  pull_request:\n    branches: [main\n    paths:\n      - src/**\n",
    {},
  ],
  ["a second YAML document", `${PR_PATHS("src/**")}---\nname: second\n`, {}],
  ["a later unclosed quote", `${PR_PATHS("src/**")}name2: 'x\n`, {}],
  ["a YAML alias elsewhere", `x: &a [1]\n${PR_PATHS("src/**")}y: *a\n`, {}],
  ["a YAML tag", `${PR_PATHS("src/**")}z: !!python/object x\n`, {}],
  ["a !!str tag on a pattern", FILTERED("  pull_request:\n    paths: [!!str src/**]"), {}],
  ["a !!map tag on an event", FILTERED("  pull_request: !!map\n    paths: [src/**]"), {}],
  ["a !!seq tag on the paths list", FILTERED("  pull_request:\n    paths: !!seq [src/**]"), {}],
  ["a tag on the on map", `name: ci\non: !!map\n  pull_request:\n    paths: [src/**]\n`, {}],
  ["a tag far from the on block", `${PR_PATHS("src/**")}extra:\n  t: !!map\n    a: b\n`, {}],
  ["an unused anchor", FILTERED("  pull_request: &filter\n    paths: [src/**]"), {}],
  ["an anchor on a pattern", FILTERED("  pull_request:\n    paths: [&p src/**]"), {}],
  ["a non-string pattern", FILTERED("  pull_request:\n    paths:\n      - 12"), {}],
  [
    "a PR file name that ** matches across a newline",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "src/a\nb.js" }] },
  ],
  [
    "a PR file name with U+2028 that ** matches",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "src/a b.js" }] },
  ],
  [
    "a PR file name with a newline that no pattern matches",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "docs/a\nb.md" }] },
  ],
  [
    "a PR file name with a control character",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "docs/a\u0007.md" }] },
  ],
  [
    "a PR file name with a lone surrogate",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "docs/a\ud800.md" }] },
  ],
  [
    "a previous_filename that is not a string",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: "README.md", previous_filename: 7 }] },
  ],
  ["a trigger name and no on block", "name: ci\njobs: {}\n# pull_request\n", {}],
  ["a tab indent", "on:\n\tpull_request:\n\t\tpaths:\n\t\t\t- src/**\n", {}],
  ["a duplicate on key", `${PR_PATHS("src/**")}on:\n  push:\n`, {}],
  ["a PR file list of 3,000", PR_PATHS("src/**"), { prFiles: MANY_FILES }],
  [
    "a PR file that changes a workflow",
    PR_PATHS("src/**"),
    { prFiles: [{ filename: ".github/workflows/x.yml" }] },
  ],
])(
  "the --all wait keeps the normal wait for a path-filtered workflow with %s",
  async (_n, text, options) => {
    const { result } = await probedWait({ workflows: { "ci.yml": text }, ...options });
    expect(result.noCheckSource).toBeUndefined();
    expect(result).toMatchObject({ timedOut: true, checks: [] });
  },
);

// Usefulness: verifies one workflow that can still run keeps the wait beside a filtered one
// (issue #1065), so the rule judges every file, not the first.
test("the --all wait keeps the normal wait when one workflow can still run", async () => {
  const { result } = await probedWait({
    workflows: { "a.yml": PR_PATHS("src/**"), "b.yml": "on:\n  push:\n" },
  });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies the states of the PR head keep the wait (issue #1054, ADR 0048): a queued
// check run, or a pending commit status, on the PR head SHA means a source reports for the head,
// even when `gh pr checks` listed nothing. The probe never returns before the by-SHA read of the head.
test.each([
  ["a queued check run", { headItems: [{ name: "ci", state: "QUEUED", bucket: "pending" }] }],
  ["a pending commit status", { headStatuses: [PENDING_STATUS] }],
])("the --all wait keeps the normal wait for %s on the PR head", async (_name, options) => {
  const { result } = await probedWait(options);
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
  expect(result.checks.length).toBeGreaterThan(0);
});

// Usefulness: verifies a workflow text that the scan cannot read as plain trigger names keeps the
// wait (issue #1054). A YAML escape decodes to an event name, so "pull_request" is
// `pull_request`, and a text with a control character hides names too.
test.each([
  ["a YAML unicode escape", '"on": ["pull_\\u0072equest"]\n'],
  ["a YAML hex escape", '"on": ["pu\\x73h"]\n'],
  ["a backslash line continuation", '"on": ["pull_\\\nrequest"]\n'],
  ["a NUL character, as in UTF-16 text", "o\u0000n\u0000: push\n"],
  ["a control character", "on: [\u0007push]\n"],
])("the --all wait keeps the normal wait for a workflow with %s", async (_name, text) => {
  const { result } = await probedWait({ workflows: { "ci.yml": text } });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies bytes that are not UTF-8 keep the wait (issue #1054), because a lossy decode
// can turn a trigger name into replacement characters.
test("the --all wait keeps the normal wait for a workflow that is not UTF-8", async () => {
  const bytes = Buffer.concat([
    Buffer.from("on: [pu"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("sh]\n"),
  ]);
  const files = fileReply("", { size: bytes.length, content: bytes.toString("base64") });
  const { result } = await probedWait({ files });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a content reply that is not valid evidence keeps the wait (issue #1054): a
// base64 string that does not decode, a wrong length, a character outside the alphabet, a size that
// disagrees with the bytes, a type that is not a file, and an encoding other than base64.
test.each([
  ["malformed base64", fileReply("on: push\n", { content: "!!!!" })],
  ["base64 of the wrong length", fileReply("on: push\n", { content: "b24" })],
  ["a base64 character outside the alphabet", fileReply("on: push\n", { content: "b24g*XNo\n" })],
  [
    "invalid base64 characters that decode away and leave a matching size",
    fileReply("on: x\n", { content: `${Buffer.from("on: x\n").toString("base64")}!!!!` }),
  ],
  ["a size that disagrees with the bytes", fileReply(INERT_WORKFLOW, { size: 3 })],
  ["a missing size", fileReply(INERT_WORKFLOW, { size: undefined })],
  ["a type that is not file", fileReply(INERT_WORKFLOW, { type: "symlink" })],
  ["an encoding other than base64", fileReply(INERT_WORKFLOW, { encoding: "none" })],
  ["no content", { type: "file", encoding: "base64", size: 0 }],
])("the --all wait keeps the normal wait for a workflow file reply with %s", async (_n, files) => {
  const { result } = await probedWait({ files });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a list that the API caps, or a reply that the wait cannot validate, keeps the
// wait (issue #1054). 3,000 PR files and 1,000 directory entries are the caps, a `Link` header on the
// directory listing says more exists, and a reply with no 2xx status block, with a body that is not
// one JSON value, or with another shape is not evidence.
test.each([
  ["3,000 PR files", { prFiles: Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}` })) }],
  [
    "1,000 directory entries",
    {
      workflows: Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [`w${i}.yml`, INERT_WORKFLOW]),
      ),
    },
  ],
  [
    "a Link header on the directory listing",
    {
      listing: {
        status: 0,
        stdout: http(200, [], 'Link: <https://api.github.com/x?page=2>; rel="next"\r\n'),
        stderr: "",
      },
    },
  ],
  [
    "a directory listing with no status block",
    { listing: { status: 0, stdout: "[]", stderr: "" } },
  ],
  [
    "a directory listing that is not one JSON value",
    { listing: { status: 0, stdout: http(200, "[] []"), stderr: "" } },
  ],
  [
    "a directory listing that is an object",
    { listing: { status: 0, stdout: http(200, { message: "x" }), stderr: "" } },
  ],
  [
    "a 404 with another text than the exact Not Found reply",
    { listing: { ...PROBE_NOT_FOUND, stderr: "gh: Not Found for another path (HTTP 404)" } },
  ],
  ["a 404 with a malformed body", { listing: { ...PROBE_NOT_FOUND, stdout: http(404, "oops") } }],
  [
    "a 404 with a Link target on a foreign host",
    {
      listing: {
        ...PROBE_NOT_FOUND,
        stdout: http(
          404,
          { message: "Not Found" },
          'Link: <https://other.example/x?page=2>; rel="next"\r\n',
        ),
      },
    },
  ],
  [
    "a JSON 502",
    {
      listing: {
        status: 1,
        stdout: http(502, { message: "Bad Gateway" }),
        stderr: "gh: Bad Gateway (HTTP 502)",
      },
    },
  ],
  [
    "a base head reply that is not a full SHA",
    { reply: { endpoint: "commits/main", result: readOk({ sha: "main" }) } },
  ],
  [
    "a base head reply with no status block",
    {
      reply: {
        endpoint: "commits/main",
        result: { status: 0, stdout: JSON.stringify({ sha: BASE_HEAD }), stderr: "" },
      },
    },
  ],
])("the --all wait keeps the normal wait for %s", async (_name, options) => {
  const { result } = await probedWait(options);
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies the probe reads every file at one base commit (issue #1054). The reads of
// the first test above answer only at the pinned SHA, so a read through the branch name finds no
// reply and keeps the wait. A base branch that moves between the first and the second resolve may
// have mixed the evidence of two commits, so the wait stays.
test("the --all wait keeps the normal wait when the base branch moves during the probe", async () => {
  const { result } = await probedWait({ baseShas: [BASE_HEAD, OTHER_BASE_HEAD] });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies a provider that reported only on a merged PR head keeps the `--all` wait
// (issue #1062), where the base head alone shows no check. The merged PR is the one that the base
// head commit belongs to, so the read reuses the paged read and the commit-state reads of the probe.
test.each([
  ["a check run", { mergedRuns: [BASE_RUN] }],
  ["a commit status", { mergedStatuses: [BASE_STATUS] }],
])("the --all wait keeps the normal wait for %s on a merged PR head", async (_name, options) => {
  const { result } = await probedWait({ mergedPrs: [MERGED_PR], ...options });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies the merged PR read adds no false positive (issue #1062): a merged PR head
// with no check, and a PR on that commit that is not merged or targets another branch, still skip.
test.each([
  ["a merged PR head with no check", [MERGED_PR]],
  ["no merged PR for the base head", []],
  ["a PR that is not merged", [{ ...MERGED_PR, merged_at: null }]],
  ["a PR of another base branch", [{ ...MERGED_PR, base: { ref: "dev" } }]],
  [
    "a PR of another base branch with a path-like name",
    [{ ...MERGED_PR, base: { ref: "release/v1.2-rc_1" } }],
  ],
])("the --all wait returns noCheckSource for %s", async (_name, mergedPrs) => {
  const { result } = await probedWait({ mergedPrs, mergedRuns: [], mergedStatuses: [] });
  expect(result.noCheckSource).toBe(true);
});

// Usefulness: verifies a PR that is not merged is never evidence (issue #1062): its head can hold
// checks without a provider reporting on merged work, so the probe reads only merged PR heads.
test("the --all wait ignores the checks of a PR that is not merged", async () => {
  const { result } = await probedWait({
    mergedPrs: [{ ...MERGED_PR, merged_at: null }],
    mergedRuns: [BASE_RUN],
  });
  expect(result.noCheckSource).toBe(true);
});

// Usefulness: verifies a failed, incomplete, or unparseable read of the merged PR head keeps the
// wait (issue #1062), one row per read and per reply shape.
test.each([
  [
    "a failed merged PR list read",
    { failing: `commits/${BASE_HEAD}/pulls`, mergedPrs: [MERGED_PR] },
  ],
  ["a failed merged head check-runs read", { failing: `commits/${MERGED_HEAD}/check-runs` }],
  ["a failed merged head status read", { failing: `commits/${MERGED_HEAD}/status` }],
  [
    "a merged PR list that is an object",
    { reply: { endpoint: `commits/${BASE_HEAD}/pulls`, result: readOk({ message: "x" }) } },
  ],
  ["a merged PR entry that is not an object", { mergedPrs: ["x"] }],
  ["a merged PR with no head SHA", { mergedPrs: [{ ...MERGED_PR, head: {} }] }],
  [
    "a merged PR with a head that is not a full SHA",
    { mergedPrs: [{ ...MERGED_PR, head: { sha: "abc" } }] },
  ],
  ["a merged PR with a malformed merge time", { mergedPrs: [{ ...MERGED_PR, merged_at: 5 }] }],
  ["a merge time that is no timestamp", { mergedPrs: [{ ...MERGED_PR, merged_at: "soon" }] }],
  [
    "a merge time that is no calendar date",
    { mergedPrs: [{ ...MERGED_PR, merged_at: "2026-02-31T00:00:00Z" }] },
  ],
  ["a PR with no base object", { mergedPrs: [{ ...MERGED_PR, base: undefined }] }],
  ["a PR with no base ref", { mergedPrs: [{ ...MERGED_PR, base: {} }] }],
  ["a PR with an empty base ref", { mergedPrs: [{ ...MERGED_PR, base: { ref: "" } }] }],
  ["a blank base ref", { mergedPrs: [{ ...MERGED_PR, base: { ref: " " } }] }],
  ["a base ref with a leading space", { mergedPrs: [{ ...MERGED_PR, base: { ref: " main" } }] }],
  [
    "a base ref with a trailing newline",
    { mergedPrs: [{ ...MERGED_PR, base: { ref: "main\n" } }] },
  ],
  ["a base ref of two dots", { mergedPrs: [{ ...MERGED_PR, base: { ref: ".." } }] }],
  [
    "a base ref with a double dot inside",
    { mergedPrs: [{ ...MERGED_PR, base: { ref: "ma..in" } }] },
  ],
  ["a base ref with a lock suffix", { mergedPrs: [{ ...MERGED_PR, base: { ref: "main.lock" } }] }],
  ["a base ref with a trailing slash", { mergedPrs: [{ ...MERGED_PR, base: { ref: "main/" } }] }],
  ["a base ref with a leading dash", { mergedPrs: [{ ...MERGED_PR, base: { ref: "-main" } }] }],
  ["a base ref with a reflog marker", { mergedPrs: [{ ...MERGED_PR, base: { ref: "ma@{in" } }] }],
  ["a base ref with a glob character", { mergedPrs: [{ ...MERGED_PR, base: { ref: "ma*in" } }] }],
  ["a base ref that is HEAD", { mergedPrs: [{ ...MERGED_PR, base: { ref: "HEAD" } }] }],
  [
    "a PR with a base ref that is an array",
    { mergedPrs: [{ ...MERGED_PR, base: { ref: ["main"] } }] },
  ],
  ["a head SHA that is an array", { mergedPrs: [{ ...MERGED_PR, head: { sha: [MERGED_HEAD] } }] }],
  [
    "an uppercase head SHA",
    { mergedPrs: [{ ...MERGED_PR, head: { sha: MERGED_HEAD.toUpperCase() } }] },
  ],
  [
    "a head SHA of 41 characters",
    { mergedPrs: [{ ...MERGED_PR, head: { sha: `${MERGED_HEAD}e` } }] },
  ],
  [
    "a malformed entry beside a valid merged PR",
    { mergedPrs: [MERGED_PR, { ...MERGED_PR, number: 8, head: { sha: ["x"] } }] },
  ],
])("the --all wait keeps the normal wait for %s", async (_name, options) => {
  const { result } = await probedWait({ mergedPrs: [MERGED_PR], ...options });
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies PRs that share the latest merge time never resolve by list order (issue
// #1062): every tied head is read, so a check on either one keeps the wait, in either list order.
const TIED_PR = { ...MERGED_PR, number: 8, head: { sha: TIED_HEAD } };
test.each([
  ["the first tied head", { mergedPrs: [MERGED_PR, TIED_PR], mergedRuns: [BASE_RUN] }],
  ["the second tied head", { mergedPrs: [MERGED_PR, TIED_PR], tiedRuns: [BASE_RUN] }],
  ["the first tied head, listed last", { mergedPrs: [TIED_PR, MERGED_PR], mergedRuns: [BASE_RUN] }],
  ["the second tied head, listed last", { mergedPrs: [TIED_PR, MERGED_PR], tiedRuns: [BASE_RUN] }],
])("the --all wait keeps the normal wait for a check on %s", async (_name, options) => {
  const { result } = await probedWait(options);
  expect(result.noCheckSource).toBeUndefined();
  expect(result.timedOut).toBe(true);
});

// Usefulness: verifies tied merge times add no false positive, and an older merged PR is not read
// (issue #1062): checks on a PR that merged earlier do not keep the wait.
test("the --all wait returns noCheckSource for tied merged PRs with no check", async () => {
  const { result } = await probedWait({ mergedPrs: [MERGED_PR, TIED_PR] });
  expect(result.noCheckSource).toBe(true);
});

test("the --all wait ignores the checks of a PR that merged before the latest", async () => {
  const older = { ...TIED_PR, merged_at: "2025-12-31T00:00:00Z" };
  const { result } = await probedWait({ mergedPrs: [MERGED_PR, older], tiedRuns: [BASE_RUN] });
  expect(result.noCheckSource).toBe(true);
});

// Usefulness: verifies the probe keeps the wait when the PR head moves while it reads (issue
// #1054), because the file list then describes another head than the commit-state read did.
test("the --all wait keeps the normal wait when the PR head moves during the probe", async () => {
  const { result } = await probedWait({ heads: [HEAD_A, HEAD_B] });
  expect(result.noCheckSource).toBeUndefined();
});

// Usefulness: verifies a named expected check keeps the wait, because the parent named a check
// that must register, and an early return would end the wait before it (issue #1054).
test("the --all wait keeps the normal wait when a check name is expected", async () => {
  const { result } = await probedWait({}, { expect: ["deploy"] });
  expect(result.noCheckSource).toBeUndefined();
  expect(result).toMatchObject({ timedOut: true, awaiting: ["deploy"] });
});

// Usefulness: verifies the required wait never returns `noCheckSource`, because the probe belongs
// to the `--all` wait alone (issue #1054).
test("the required wait never returns noCheckSource", async () => {
  const clock = fakeClock();
  const result = await waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    gh: probeGh({ all: false }),
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(result.noCheckSource).toBeUndefined();
});
