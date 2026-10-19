// Script run by `withTurnTmpdir` in a short-lived child: node turn-tmpdir-remove.mjs <real path of
// the parent> <name>. The working directory is the parent. Exit 0: removed or already gone.
// Exit 3: refused, nothing deleted. Any other code: a failure.
//
// Every step after the start works on a directory that this process already holds as its working
// directory, or on a bare name inside it, so a swap of the target or of a parent path component
// after the check cannot steer a delete: a path component that changes later is never read again.
import {
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";

const REFUSED = 3;
const FAILED = 1;
const [parentReal, name] = process.argv.slice(2);

function refuse() {
  process.exit(REFUSED);
}

if (!parentReal || !name || /[\\/]/.test(name)) refuse();
// A parent that changed since creation is not the directory that holds the turn directory.
if (realpathSync.native(".") !== parentReal) refuse();

let before;
try {
  before = lstatSync(name, { bigint: true });
} catch (err) {
  process.exit(err.code === "ENOENT" ? 0 : FAILED);
}
if (before.isSymbolicLink()) {
  // A link or junction at the target is removed as an entry and never followed.
  unlinkSync(name);
  process.exit(0);
}
if (!before.isDirectory()) refuse();

process.chdir(name);
const inside = statSync(".", { bigint: true });
// A swap between the check and the chdir leaves this process in another directory. Delete nothing.
if (inside.ino !== before.ino || inside.dev !== before.dev) refuse();

for (const entry of readdirSync(".")) {
  rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
// `..` is the real parent of the directory that this process holds, whatever its path became.
process.chdir("..");
rmdirSync(name);
