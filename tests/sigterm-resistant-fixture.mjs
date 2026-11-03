/**
 * Scripts for the node child that the real-signal tests spawn with `node -e`. `process.argv[1]` is
 * the pid file that a test waits on. Each script installs its SIGTERM handler before it writes that
 * file. A signal sent once the file appears then reaches a process that has a handler (issue #1067).
 */
const HOLD = `function hold(prefix) {
  if (!prefix) return;
  const release = prefix + "-" + process.pid;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 25);
  fs.writeFileSync(release + ".resumed", "");
}`;

const CHILD = [
  'const fs = require("fs");',
  'process.on("SIGTERM", () => {});',
  // The hold call stays on the pid write statement. A swap of this statement with the handler
  // install then leaves the hold between the write and the handler: the old order.
  "fs.writeFileSync(process.argv[1], String(process.pid)); hold(process.env.SIGTERM_FIXTURE_HOLD);",
  HOLD,
];

/** The script for one child. */
export const RESISTANT_CHILD = [...CHILD, "setInterval(() => {}, 1000);"].join("\n");

/**
 * The script for a child that starts a grandchild with the same script. `process.argv[2]` marks the
 * grandchild, which receives `process.argv[3]` as its own source.
 */
export const RESISTANT_TREE = [
  ...CHILD,
  'if (!process.argv[2]) require("child_process").spawn(process.execPath, ["-e", process.argv[3], process.argv[1] + ".grand", "grand", process.argv[3]], { stdio: "ignore" });',
  "setInterval(() => {}, 1000);",
].join("\n");

/**
 * When `SIGTERM_FIXTURE_HOLD` names a prefix, the child holds the window after its pid file write
 * open until the test writes `<prefix>-<pid>`, then writes `<prefix>-<pid>.resumed`. The hold keeps
 * that window open with no fixed sleep. A test then never depends on how long it takes to observe
 * the pid file.
 */
export const HOLD_ENV = "SIGTERM_FIXTURE_HOLD";
