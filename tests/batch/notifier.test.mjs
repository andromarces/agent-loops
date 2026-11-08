import { expect, test } from "vite-plus/test";
import { NOTIFY_MAX_CHARS, notify, notificationInvocation } from "../../src/batch/notifier.mjs";

const HOSTILE = `He said "hi" and \`quoted\` $(rm -rf /) 50%\nsecond line ünïcode ✓`;

// Usefulness: macOS carries the text as one argv entry, never inside the AppleScript source.
test("the macOS invocation passes the text as one argument", () => {
  const invocation = notificationInvocation({ title: "A title", text: HOSTILE }, "darwin");
  expect(invocation.command).toBe("osascript");
  expect(invocation.args).toContain(HOSTILE);
  const script = invocation.args[invocation.args.indexOf("-e") + 1];
  expect(script).toContain("on run argv");
  expect(script).not.toContain(HOSTILE);
});

// Usefulness: Windows carries the text in environment values, never inside the script string.
test("the Windows invocation passes the text in the environment", () => {
  const invocation = notificationInvocation({ title: "A title", text: HOSTILE }, "win32");
  expect(invocation.command).toBe("powershell.exe");
  expect(invocation.args).toContain("-NoProfile");
  expect(invocation.args).toContain("-NonInteractive");
  expect(invocation.env.AL_BATCH_NOTIFY_TEXT).toBe(HOSTILE);
  expect(invocation.env.AL_BATCH_NOTIFY_TITLE).toBe("A title");
  expect(invocation.args.join(" ")).not.toContain(HOSTILE);
});

// Usefulness: Linux and other platforms build no command and spawn nothing.
test("Linux builds no notification command", async () => {
  expect(notificationInvocation({ title: "A title", text: HOSTILE }, "linux")).toBeNull();
  let calls = 0;
  const result = await notify(
    { kind: "decision", title: "A title", text: HOSTILE },
    {
      platform: "linux",
      execBounded: async () => {
        calls += 1;
        return { exitCode: 0 };
      },
    },
  );
  expect(result.spawned).toBe(false);
  expect(calls).toBe(0);
});

// Usefulness: a control character is removed and a long text stays within its bound.
test("the text is bounded and stripped of control characters", () => {
  const invocation = notificationInvocation(
    { title: "A title", text: `a\u0000b\u0007c${"x".repeat(NOTIFY_MAX_CHARS * 2)}` },
    "darwin",
  );
  const text = invocation.args[2];
  expect(text).not.toContain("\u0000");
  expect(text).not.toContain("\u0007");
  expect(text.startsWith("abc")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(NOTIFY_MAX_CHARS);
});

// Usefulness: a nonzero exit is a warning, never a thrown failure of the batch.
test("a nonzero notifier exit warns and does not throw", async () => {
  const warnings = [];
  const result = await notify(
    { kind: "decision", title: "A title", text: "text" },
    {
      platform: "darwin",
      execBounded: async () => ({ exitCode: 1 }),
      logWarn: (message) => warnings.push(message),
    },
  );
  expect(result).toMatchObject({ spawned: true, ok: false });
  expect(warnings).toHaveLength(1);
});

// Usefulness: a missing binary is a warning, never a thrown failure of the batch.
test("a missing notifier binary warns and does not throw", async () => {
  const warnings = [];
  const result = await notify(
    { kind: "decision", title: "A title", text: "text" },
    {
      platform: "darwin",
      execBounded: async () => {
        throw Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" });
      },
      logWarn: (message) => warnings.push(message),
    },
  );
  expect(result).toMatchObject({ spawned: true, ok: false });
  expect(warnings).toHaveLength(1);
});

// Usefulness: a notifier that passes its bound is a warning, never a stalled batch.
test("a timed out notifier warns and does not throw", async () => {
  const warnings = [];
  const result = await notify(
    { kind: "decision", title: "A title", text: "text" },
    {
      platform: "win32",
      execBounded: async () => ({ exitCode: null, timedOut: true }),
      logWarn: (message) => warnings.push(message),
    },
  );
  expect(result).toMatchObject({ spawned: true, ok: false });
  expect(warnings).toHaveLength(1);
});
