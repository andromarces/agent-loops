/**
 * Scripts for the node child that the real-signal tests spawn with `node -e`. `process.argv[1]` is
 * the pid file that a test waits on. Each script installs its SIGTERM handler before it writes that
 * file. A signal sent once the file appears then reaches a process that has a handler (issue #1067).
 */
export const RESISTANT_CHILD =
  'process.on("SIGTERM", () => {});' +
  'require("fs").writeFileSync(process.argv[1], String(process.pid));' +
  "setInterval(() => {}, 1000);";

/**
 * `RESISTANT_CHILD` plus a grandchild that runs the same script. `process.argv[2]` marks the
 * grandchild, which receives `process.argv[3]` as its own source.
 */
export const RESISTANT_TREE =
  'process.on("SIGTERM", () => {});' +
  'const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid));' +
  "setInterval(() => {}, 1000);" +
  'if (!process.argv[2]) require("child_process").spawn(process.execPath, ["-e", process.argv[3], process.argv[1] + ".grand", "grand", process.argv[3]], { stdio: "ignore" });';
