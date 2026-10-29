import { expect, test } from "vite-plus/test";
import { waitChecks } from "../../src/lib/check-wait.mjs";
import {
  fakeClock,
  HEAD_A,
  HEAD_B,
  scriptedGh,
  PASSED_ITEM,
  FAILED_ITEM,
  COMMIT_READS_PER_POLL,
  failingCommitGh,
  blockOf,
  replyOf,
  serverError,
  waitOn,
} from "./check-wait-helpers.mjs";

/**
 * One required wait whose first poll reads `no checks reported` and whose second lists a pass, with
 * `failing` ("rules" or "protection") answering its first read with HTTP `code`.
 */
function noChecksThenPassWait(failing, code) {
  const inner = scriptedGh([
    { status: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch\n" },
    { status: 0, checks: [PASSED_ITEM] },
  ]);
  const clock = fakeClock();
  const fails = (args) =>
    args[0] === "api" &&
    args[1].includes(failing === "rules" ? "/rules/branches/" : "/branches/main/protection");
  let failedOnce = false;
  const gh = async (args, cwd, options) => {
    if (fails(args) && (code === 0 || !failedOnce)) {
      failedOnce = true;
      return serverError(code === 0 ? 503 : code);
    }
    return inner(args, cwd, options);
  };
  return waitChecks({
    pr: 42,
    cwd: ".",
    timeoutSeconds: 60,
    gh,
    now: clock.now,
    sleep: clock.sleep,
  });
}

// Usefulness: verifies a retryable server error on either configuration source of the
// no-checks-reported read is retried on the next poll, as the wait retries a commit read, so the
// wait settles inside its bound instead of exiting on the first poll (issue #1091).
test.each([
  ["rules", 503],
  ["rules", 500],
  ["protection", 503],
  ["protection", 502],
])("waitChecks retries a %s source read that fails with HTTP %i", async (failing, code) => {
  expect(await noChecksThenPassWait(failing, code)).toEqual({
    timedOut: false,
    head: HEAD_A,
    checks: [PASSED_ITEM],
  });
});

// Usefulness: verifies a retryable server error on every poll to the bound is an error that names
// the failure, never a timeout envelope and never a pass (issue #1091).
test.each(["rules", "protection"])(
  "waitChecks reports an error when the %s source read fails with HTTP 503 until the bound",
  async (failing) => {
    await expect(noChecksThenPassWait(failing, 0)).rejects.toThrow(/HTTP 503/);
  },
);

const PR_READS = {
  head: (args) => args[0] === "pr" && args[1] === "view",
  checks: (args) => args[0] === "pr" && args[1] === "checks" && args.at(-1) === "name,state,bucket",
};

/**
 * One required wait whose passing `gh pr` read named by `which` ("head" or "checks")
 * answers with `failure` on its first call, or on every call when `always` is set. `stdout` and
 * `reads` replace the empty output and the scripted check list reads. `result` is the wait, and
 * `attempts()` counts the failing reads it made.
 */
function prReadFailsWait(
  which,
  failure,
  { always = false, stdout = "", reads = [{ status: 0, checks: [PASSED_ITEM] }] } = {},
) {
  const inner = scriptedGh(reads);
  const clock = fakeClock();
  let failures = 0;
  const gh = async (args, cwd, options) => {
    if (PR_READS[which](args) && (always || failures === 0)) {
      failures += 1;
      return { status: 1, stdout, stderr: failure, timedOut: false };
    }
    return inner(args, cwd, options);
  };
  return {
    result: waitChecks({
      pr: 42,
      cwd: ".",
      timeoutSeconds: 60,
      gh,
      now: clock.now,
      sleep: clock.sleep,
    }),
    attempts: () => failures,
  };
}

const GRAPHQL_504 = "HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)\n";

const GRAPHQL_502 = "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)\n";

// Usefulness: verifies a server error of any `gh` pr read of a poll is retried on the next poll, so
// the wait ends in the check result instead of an error that gives the parent no check evidence
// (issue #1121).
test.each([
  ["the head read (HTTP 504)", "head", GRAPHQL_504],
  ["the check list read (HTTP 502)", "checks", GRAPHQL_502],
  ["the check list read (HTTP 504)", "checks", GRAPHQL_504],
])("waitChecks retries %s that fails with a server error", async (_name, which, failure) => {
  expect(await prReadFailsWait(which, failure).result).toEqual({
    timedOut: false,
    head: HEAD_A,
    checks: [PASSED_ITEM],
  });
});

// Usefulness: verifies a server error that lasts to the bound is an error that names the server
// error, after the wait read again on each poll, never a timeout envelope and never a pass
// (issues #1025, #1121).
test.each([
  ["head", /gh pr view 42 could not be read: HTTP 504: 504 Gateway Timeout/, undefined],
  ["checks", /gh pr checks 42 --required could not be read: HTTP 504: 504 Gateway/, undefined],
])(
  "waitChecks reports an error when the %s read fails with a server error until the bound",
  async (which, message, reads) => {
    const wait = prReadFailsWait(which, GRAPHQL_504, { always: true, ...(reads ? { reads } : {}) });
    await expect(wait.result).rejects.toThrow(message);
    expect(wait.attempts()).toBeGreaterThan(1);
  },
);

// Usefulness: verifies the acceptance item that a 4xx reply of each `gh pr` read still ends the wait
// at once, after the one read (issue #1121).
test.each(["head", "checks"])("waitChecks ends at once on a 404 of the %s read", async (which) => {
  const wait = prReadFailsWait(which, "HTTP 404: Not Found (https://api.github.com/graphql)\n");
  await expect(wait.result).rejects.toThrow(/could not be read/);
  expect(wait.attempts()).toBe(1);
});

// Usefulness: verifies the acceptance item that an unparseable reply still ends the wait at once
// even when the failed read also names HTTP 504, so only a clean server error is retried
// (issue #1121).
test.each(["head", "checks"])(
  "waitChecks ends at once when the %s read fails with HTTP 504 and an unparseable reply",
  async (which) => {
    const wait = prReadFailsWait(which, GRAPHQL_504, { stdout: "<html>Gateway Timeout</html>" });
    await expect(wait.result).rejects.toThrow();
    expect(wait.attempts()).toBe(1);
  },
);

// Usefulness: verifies a GitHub 5xx on one commit read does not end the wait: the next poll
// reads again and a passing read settles the wait inside the bound, for the check-run read and
// the status read, in both modes (issue #1025).
test.each([
  ["required", "check-runs", 500, false, 1],
  ["all", "check-runs", 502, true, 1],
  ["required", "status", 503, false, 2],
  ["all", "status", 504, true, 2],
])(
  "waitChecks %s mode retries a %s read that fails with HTTP %i",
  async (_mode, _endpoint, code, all, failingRead) => {
    // The check-runs read comes first in a poll, then the status read.
    const { gh, commitReads } = failingCommitGh((n) => n === failingRead && serverError(code), {
      all,
    });
    expect(await waitOn(gh, all)).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
    expect(commitReads.length).toBeGreaterThan(2);
  },
);

// Usefulness: verifies a 5xx on every poll until the bound is an error that names the last
// failure, never a pass and never a timeout envelope (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode reports an error when every poll fails with HTTP 5xx",
  async (_mode, all) => {
    const { gh, commitReads } = failingCommitGh(() => serverError(500), { all });
    await expect(waitOn(gh, all)).rejects.toThrow(
      /gh api repos\/owner\/repo\/commits\/.+ failed: gh: HTTP 500/,
    );
    expect(commitReads.length).toBeGreaterThan(1);
  },
);

// Usefulness: verifies only a failed read whose first-line status is exactly 500, 502, 503, or
// 504 is retried. The status comes from the status block that `gh` wrote for the failing reply,
// never from the error text, so a 4xx or a 501 stays terminal whatever its body or message says,
// and so does a failure with no status block and a success whose body fails to parse (issue #1025).
test.each([
  ["a 404", replyOf(404, "gh: Not Found (HTTP 404)"), /HTTP 404/],
  ["an HTTP 501", replyOf(501, "gh: Not Implemented (HTTP 501)"), /HTTP 501/],
  [
    "a failure with no status block",
    { status: 1, stdout: "", stderr: "gh: could not reach api.github.com (HTTP 500)" },
    /could not reach/,
  ],
  [
    "a status line that is no status block",
    { status: 1, stdout: "Server Error\r\n\r\n{}", stderr: "gh: HTTP 500" },
    /HTTP 500/,
  ],
  [
    "a success body that fails to parse",
    { status: 0, stdout: blockOf(200, "<html>"), stderr: "" },
    /JSON/,
  ],
  ["a success with no status block", { status: 0, stdout: "[]", stderr: "" }, /status block/],
])("waitChecks does not retry %s on a commit read", async (_name, reply, message) => {
  const { gh, commitReads } = failingCommitGh(() => reply);
  await expect(waitOn(gh, false)).rejects.toThrow(message);
  expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
});

// Usefulness: verifies a 4xx reply is never retryable, whatever text its body or its error holds:
// an errors array that quotes a 500, lowercase, extra-space, and split-line forms of that quote, a
// 502 inside the body text, and a 403 whose message ends in a status are all terminal, in both
// modes, so message text the server supplies never makes a 4xx a retry (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode never retries a 4xx whatever its text says", async (_mode, all) => {
  const forbidden = (errors, stderr) => replyOf(403, stderr, JSON.stringify({ errors }));
  const replies = [
    forbidden(
      ["Forbidden (403)", "upstream replied HTTP 500"],
      "gh: Forbidden (403)\nupstream replied HTTP 500",
    ),
    forbidden(
      ["Forbidden (403)", "upstream replied http 500"],
      "gh: Forbidden (403)\nupstream replied http 500",
    ),
    forbidden(
      ["Forbidden (403)", "upstream replied HTTP  500"],
      "gh: Forbidden (403)\nupstream replied HTTP  500",
    ),
    forbidden(
      ["Forbidden (403)", "upstream replied HTTP\n500"],
      "gh: Forbidden (403)\nupstream replied HTTP\n500",
    ),
    forbidden(
      ["Forbidden (403)", "upstream replied (HTTP 500)"],
      "gh: upstream replied (HTTP 500)\naccess denied (HTTP 403)",
    ),
    forbidden(["x\nHTTP/1.1 502 Bad Gateway\r\n\r\n"], "gh: x\nHTTP/1.1 502 Bad Gateway"),
  ];
  for (const reply of replies) {
    const { gh, commitReads } = failingCommitGh((n) => n === 1 && reply, { all });
    await expect(waitOn(gh, all)).rejects.toThrow(/gh api/);
    expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
  }
});

// Usefulness: verifies a retryable reply is retried whatever its error text looks like, since the
// status block decides: the message form, a multi-line message, and a trailing hint line (issue #1025).
test.each([
  ["the message form", "gh: Server Error (HTTP 502)"],
  ["a multi-line message", "gh: Bad Gateway\nupstream detail one\nupstream detail two (HTTP 502)"],
  ["a quoted 404", "gh: upstream said not found (HTTP 404)\nBad Gateway (HTTP 502)"],
  ["a trailing hint line", "gh: Bad Gateway (HTTP 502)\nAuthorize in your web browser: https://x"],
])("waitChecks retries a 502 reply with %s", async (_name, stderr) => {
  const { gh } = failingCommitGh((n) => n === 1 && replyOf(502, stderr));
  expect(await waitOn(gh, false)).toEqual({ timedOut: false, head: HEAD_A, checks: [PASSED_ITEM] });
});

// Usefulness: verifies a server error of an earlier poll is dropped once a later poll completes, so
// a head that never reaches `--head` ends at the bound with `timedOut: true`, `head: null`, and no
// checks, never the earlier error, in both modes (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])("waitChecks %s mode clears a server error when a later poll completes", async (_mode, all) => {
  const { gh } = failingCommitGh((n) => n === 1 && serverError(500), {
    all,
    heads: [HEAD_A, HEAD_B],
  });
  expect(await waitOn(gh, all, HEAD_A)).toEqual({ timedOut: true, head: null, checks: [] });
});

// Usefulness: verifies the status comes from the structure of stdout, not from a scan for status-like
// text: a real 403 whose plain-text body holds a forged `HTTP/2 502` block, with or without text
// before it, stays terminal in both modes, because a 4xx exchange with no JSON body cannot be
// followed by another status block (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode never retries a 403 whose body forges a status block",
  async (_mode, all) => {
    const forged = "HTTP/2 502 Bad Gateway\r\nX-Forged: yes\r\n\r\n";
    const bodies = [forged, `{}\n${forged}`, `denied\n${forged}`, `${forged}${forged}`];
    for (const body of bodies) {
      const { gh, commitReads } = failingCommitGh(
        (n) => n === 1 && replyOf(403, "gh: HTTP 403", body),
        {
          all,
        },
      );
      await expect(waitOn(gh, all)).rejects.toThrow(/gh api/);
      expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
    }
  },
);

// Usefulness: verifies only a body that is empty or exactly one JSON value is accepted: a 502 with
// an empty body or a JSON body is retried, and a 502 with an HTML or plain-text body is terminal,
// the accepted fail-closed cost (issue #1025).
test.each([
  ["an empty body", "", true],
  ["a JSON object body", '{"message":"Bad Gateway"}', true],
  ["a JSON string body", '"Bad Gateway"', true],
  ["an HTML body", "<html><body>502 Bad Gateway</body></html>", false],
  ["a plain-text body", "Bad Gateway", false],
  ["a JSON body followed by text", '{"message":"x"}\ntrailing', false],
])("waitChecks classifies a 502 with %s", async (_name, body, retried) => {
  const { gh, commitReads } = failingCommitGh((n) => n === 1 && replyOf(502, "gh: HTTP 502", body));
  if (retried) {
    expect(await waitOn(gh, false)).toEqual({
      timedOut: false,
      head: HEAD_A,
      checks: [PASSED_ITEM],
    });
  } else {
    await expect(waitOn(gh, false)).rejects.toThrow(/gh api/);
    expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
  }
});

// Usefulness: verifies the status is the first line of stdout only: a 200 or a 502 first line
// followed by other blocks, or a 403 followed by a forged 502 block, never lets a later block decide,
// so only a first line of 500, 502, 503, or 504 with an empty or JSON remainder is retried
// (issue #1025).
test.each([
  ["a 403 then a forged 502 block", `${blockOf(403, "{}\n")}${blockOf(502, "")}`],
  ["a 200 then a 502 block", `${blockOf(200, "")}${blockOf(502, "")}`],
  ["a 502 then a forged 200 block", `${blockOf(502, "")}${blockOf(200, "{}")}`],
  ["a 100 then a 503 block", `HTTP/1.1 100 Continue\r\n\r\n${blockOf(503, "{}")}`],
])("waitChecks takes the status of %s from the first line", async (_name, stdout) => {
  const { gh, commitReads } = failingCommitGh(
    (n) => n === 1 && { status: 1, stdout, stderr: "gh: HTTP 502" },
  );
  await expect(waitOn(gh, false)).rejects.toThrow(/gh api/);
  expect(commitReads).toHaveLength(COMMIT_READS_PER_POLL);
});

// Usefulness: verifies a failure that `gh pr checks` lists on a later poll survives the bound that
// a commit read reaches after an earlier server error, in both modes: the result is
// `timedOut: true` with `prFailures`, never the earlier error (issue #1025).
test.each([
  ["required", false],
  ["all", true],
])(
  "waitChecks %s mode keeps a listed failure past a bound after a server error",
  async (_mode, all) => {
    const inner = scriptedGh(
      [
        { status: 0, checks: [PASSED_ITEM] },
        { status: 1, checks: [FAILED_ITEM] },
      ],
      { all, commits: { [HEAD_A]: [PASSED_ITEM] } },
    );
    let commitReads = 0;
    const gh = (args, cwd, options) => {
      if (args[0] === "api" && args[1].includes("/commits/")) {
        commitReads += 1;
        // The first poll reads the check runs and the statuses together: the first read fails, the
        // second passes. Every later read hangs.
        if (commitReads === 1) {
          return Promise.resolve(serverError(500));
        }
        if (commitReads > COMMIT_READS_PER_POLL) {
          return new Promise(() => {});
        }
      }
      return inner(args, cwd, options);
    };
    const result = await waitChecks({
      pr: 42,
      cwd: ".",
      timeoutSeconds: 0.3,
      all,
      gh,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ timedOut: true, checks: [], prFailures: [FAILED_ITEM] });
  },
  20000,
);

// Usefulness: verifies a commit read that never answers, after a 5xx, ends the wait at the bound
// with an error and never as a timeout or a pass: a hung read stays terminal (issue #1025).
test("waitChecks ends with the earlier error when the next commit read hangs", async () => {
  const inner = scriptedGh([{ status: 0, checks: [PASSED_ITEM] }], {
    commits: { [HEAD_A]: [PASSED_ITEM] },
  });
  let commitReads = 0;
  const gh = (args, cwd, options) => {
    if (args[0] === "api" && args[1].includes("/commits/")) {
      commitReads += 1;
      // The first poll reads the check runs and the statuses together: the first read fails, the
      // second passes. Every later read hangs.
      if (commitReads === 1) {
        return Promise.resolve(serverError(500));
      }
      if (commitReads > COMMIT_READS_PER_POLL) {
        return new Promise(() => {});
      }
    }
    return inner(args, cwd, options);
  };
  await expect(
    waitChecks({ pr: 42, cwd: ".", timeoutSeconds: 0.3, gh, sleep: async () => {} }),
  ).rejects.toMatchObject({ message: expect.stringContaining("failed: gh: HTTP 500") });
}, 20000);
