import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export class MutationError extends Error {
  constructor(role, paths) {
    super(`Mutation detected during ${role} turn: ${paths.join(", ")}`);
    this.name = "MutationError";
    this.role = role;
    this.paths = paths;
  }
}

export async function assertGitWorkTree(cwd) {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    reject: false,
  });

  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error(`--cwd must be inside a Git work tree: ${cwd}`);
  }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(path) {
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      return null;
    }
    const content = await readFile(path);
    return sha256(content);
  } catch {
    return null;
  }
}

export async function snapshot(cwd) {
  // 1. Work tree status
  const statusResult = await execa(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd, reject: false },
  );

  const statusTokens = statusResult.stdout.split("\0");
  const entries = [];

  for (let i = 0; i < statusTokens.length; i++) {
    const token = statusTokens[i];
    if (!token) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);

    // If rename/copy (status 'R' or 'C'), -z outputs <new-path>\0<old-path>\0.
    // filePath is already <new-path>; consume <old-path> in nextToken so it is not processed as a file.
    if (status.includes("R") || status.includes("C")) {
      i++;
    }

    const fullPath = join(cwd, filePath);
    const hash = await sha256File(fullPath);
    entries.push({ path: filePath, status, hash });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  // 2. Index hash
  const lsResult = await execa("git", ["ls-files", "--stage", "-z"], { cwd, reject: false });
  const indexHash = sha256(lsResult.stdout);

  // 3. HEAD
  const headResult = await execa("git", ["rev-parse", "--verify", "-q", "HEAD"], {
    cwd,
    reject: false,
  });
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : "unborn";

  return {
    workTree: entries,
    indexHash,
    head,
  };
}

export function diffSnapshots(before, after) {
  const changed = new Set();

  const beforeMap = new Map(before.workTree.map((e) => [e.path, e]));
  const afterMap = new Map(after.workTree.map((e) => [e.path, e]));

  for (const [path, b] of beforeMap.entries()) {
    const a = afterMap.get(path);
    if (!a) {
      // It was dirty and now it's not (e.g. reverted or staged/committed)
      changed.add(path);
    } else if (b.status !== a.status || b.hash !== a.hash) {
      changed.add(path);
    }
  }

  for (const [path] of afterMap.entries()) {
    if (!beforeMap.has(path)) {
      changed.add(path);
    }
  }

  const result = Array.from(changed).sort();

  if (before.indexHash !== after.indexHash) {
    result.push("<index>");
  }

  if (before.head !== after.head) {
    result.push("<HEAD>");
  }

  return result;
}

export async function withMutationCheck(cwd, role, fn) {
  const before = await snapshot(cwd);
  let actionError = null;
  let result;

  try {
    result = await fn();
  } catch (err) {
    actionError = err;
  }

  let after;
  try {
    after = await snapshot(cwd);
  } catch (snapErr) {
    if (actionError) throw actionError;
    throw snapErr;
  }

  const diff = diffSnapshots(before, after);
  if (diff.length > 0) {
    throw new MutationError(role, diff);
  }

  if (actionError) {
    throw actionError;
  }

  return result;
}
