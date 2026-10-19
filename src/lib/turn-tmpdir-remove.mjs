// Script run by `withTurnTmpdir` in a short-lived child:
//   node turn-tmpdir-remove.mjs <real path of the parent> <name> <device> <inode>
// The working directory is the parent. The device and inode are those of the directory that the
// runtime created. Exit 0: removed or already gone. Exit 3: refused. Any other code: a failure.
//
// The helper acts only on a directory whose device and inode match the created one, and checks
// that before every step that acts on a path: the start, the chdir into the target, and the final
// `rmdir`. A replacement at any of those steps loses nothing. Between the chdir and the deletes,
// the helper holds the directory as its working directory, so a later swap of the target or of a
// parent path component cannot steer a delete.
// known-limit: the final `rmdir` still names the directory by path, because Node has no
// directory-handle delete. A replacement that appears between the identity check and that call
// loses at most an empty directory, since `rmdir` fails on a directory that holds an entry.
import { lstatSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync } from "node:fs";

const REFUSED = 3;
const FAILED = 1;
const [parentReal, name, device, inode] = process.argv.slice(2);

function refuse() {
  process.exit(REFUSED);
}

const sameIdentity = (stat) => String(stat.dev) === device && String(stat.ino) === inode;

if (!parentReal || !name || /[\\/]/.test(name)) refuse();
// An inode of 0 identifies nothing, so no directory can be matched to the created one.
if (!device || !/^[1-9]\d*$/.test(inode ?? "")) refuse();
// A parent that changed since creation is not the directory that holds the turn directory.
if (realpathSync.native(".") !== parentReal) refuse();

// The entry of `name` in the working directory: null when gone, refused when it is not the
// directory that the runtime created.
function checkedEntry() {
  let stat;
  try {
    stat = lstatSync(name, { bigint: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!stat.isDirectory() || !sameIdentity(stat)) refuse();
  return stat;
}

try {
  if (checkedEntry() === null) process.exit(0);
  process.chdir(name);
  // A swap between the check and the chdir leaves this process in another directory. Delete nothing.
  if (!sameIdentity(statSync(".", { bigint: true }))) refuse();
  for (const entry of readdirSync(".")) {
    rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  // `..` is the real parent of the directory that this process holds, whatever its path became.
  process.chdir("..");
  if (checkedEntry() !== null) rmdirSync(name);
} catch (err) {
  process.stderr.write(`${err?.code ?? "error"}: ${err?.message ?? err}\n`);
  process.exit(FAILED);
}
