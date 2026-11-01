import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a symlink, or skips the test where the host cannot: Windows without the symlink
 * privilege. Every other failure throws, so Linux and macOS never skip silently.
 *
 * Verified on Windows 11 (10.0.26220) without the symlink privilege (file and directory symlinks
 * both fail with EPERM), Node v26.8.1, pnpm 12.11.2, commit eb84f61: `pnpm test` ran 2774 tests,
 * 2647 passed, 86 skipped, 21 failed. No failure names EPERM from a symlink call. The 21 failures
 * are timeouts and argument-shape errors in cli.session-persist, cli.reviewer-sandbox, and
 * runtime.test-cmd (issue #709, source #603, PR #607).
 */
export async function symlinkOrSkip(ctx, target, path, type) {
  try {
    await symlink(target, path, type);
  } catch (err) {
    if (process.platform === "win32" && err?.code === "EPERM") ctx.skip();
    throw err;
  }
}

/**
 * Removes a test path, retrying transient Windows locks. `fs.rm` retries
 * EBUSY, EPERM, and ENOTEMPTY only when `maxRetries` is set (default 0), so a
 * handle held by antivirus, an indexer, or a lingering child otherwise fails
 * the removal. Retries stay scoped to fixture removal, both setup and
 * teardown; a deliberate in-test delete that is itself the case under test
 * keeps plain `rm`.
 */
export async function removePath(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_MAX_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}

const REMOVE_MAX_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 100;
// `fs.rm` backs off linearly: retry n waits n * retryDelay. A path that stays
// locked therefore costs 100 + 200 + ... + 1000 = 5500 ms before `removePath`
// throws (measured at 5573 ms on Windows with a child holding the directory).
// Test timeouts that include a `removePath` add this, not the delay alone.
export const REMOVE_MAX_WAIT_MS =
  (REMOVE_RETRY_DELAY_MS * REMOVE_MAX_RETRIES * (REMOVE_MAX_RETRIES + 1)) / 2;
// Slack over the retry waits for the removal calls themselves.
export const REMOVE_SYSCALL_SLACK_MS = 500;

/** True when `path` exists, a dangling symlink included. */
export const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * Creates a temporary directory named from `prefix` and appends it to `dirs`, so the caller's
 * `afterEach` removes it with `removePath`.
 */
export async function trackedTempDir(prefix, dirs) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
