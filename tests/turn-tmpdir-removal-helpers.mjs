// Answers the turn directory removal in this process, so an adapter test starts no
// `turn-tmpdir-remove.mjs` child per turn. `delegate` serves every other command, so the adapter
// still reaches the real `execBounded`. A removal acts only on a directory with the recorded
// identity below the recorded parent, as the helper does.
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const REMOVER = "turn-tmpdir-remove.mjs";
const REFUSED = 3;

/** Wraps `delegate` so the removal helper runs in this process and every other command reaches `delegate`. */
export function turnTmpdirRemovalDouble(delegate) {
  return (command, args = [], options = {}) =>
    basename(args[0] ?? "") === REMOVER
      ? removeNow(args.slice(1), options.cwd)
      : delegate(command, args, options);
}

// Removes the recorded directory below `cwd` and returns the exit code that the helper reports.
// A changed parent, a changed identity, and a link refuse without a delete.
function removeNow([parentReal, name, device, inode], cwd) {
  if (!parentReal || !name || /[\\/]/.test(name)) return { exitCode: REFUSED };
  if (!device || !/^[1-9]\d*$/.test(inode ?? "")) return { exitCode: REFUSED };
  const dir = join(cwd, name);
  let parent;
  try {
    parent = realpathSync.native(cwd);
  } catch (err) {
    return failure(err);
  }
  if (parent !== parentReal) return { exitCode: REFUSED };
  try {
    const stat = lstatSync(dir, { bigint: true });
    if (!stat.isDirectory() || String(stat.dev) !== device || String(stat.ino) !== inode) {
      return { exitCode: REFUSED };
    }
  } catch (err) {
    return err?.code === "ENOENT" ? { exitCode: 0 } : failure(err);
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    return failure(err);
  }
  return { exitCode: 0 };
}

function failure(err) {
  return { exitCode: 1, stderr: `${err?.code ?? "error"}: ${err?.message ?? err}` };
}
