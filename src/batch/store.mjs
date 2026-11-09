// Local batch stores (ADR 0106 decisions 7 and 8): one atomic claim file per repository and
// issue, and one checkpoint per batch and loop. Nothing here writes to GitHub, and every write
// is skipped when the stored value does not change.
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeTemp, writeFileAtomic } from "../lib/atomic-write.mjs";
import { isJsonObject } from "../lib/json.mjs";
import { ownerAlive } from "../lib/process-identity.mjs";
import { withStateLock } from "../lib/state-lock.mjs";
import { loopSegment } from "./items.mjs";

// One in-process chain per lock path, so concurrent writes of one batch process never meet the
// live-owner refusal of the cross-process state lock.
const chains = new Map();
function serialized(key, fn) {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // The chain entry always settles, so a failed call is returned to its caller but never becomes
  // an unhandled rejection or poisons the next call.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  const tail = settled.finally(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  chains.set(key, tail);
  return run;
}

const LINK_UNSUPPORTED = new Set([
  "EPERM",
  "EACCES",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EINVAL",
  "ENOSYS",
  "EMLINK",
  "EXDEV",
  "EISDIR",
]);

/** The paths of the batch store under one runs root. */
export function batchPaths(runsRoot) {
  const root = join(runsRoot, "batches");
  const batchDir = (id) => join(root, id);
  return {
    root,
    claims: join(root, "claims"),
    batchDir,
    manifest: (id) => join(batchDir(id), "batch.json"),
    loop: (id, key) => join(batchDir(id), "loops", `${loopSegment(key)}.json`),
    transcript: (id, key) => join(batchDir(id), "transcripts", `${loopSegment(key)}.json`),
    log: (id, key, attempt) => join(batchDir(id), "logs", `${loopSegment(key)}.${attempt}.log`),
    lock: (id) => join(batchDir(id), "batch.lock"),
    decisions: (id) => join(batchDir(id), "decisions"),
    answers: (id) => join(batchDir(id), "answers"),
    decision: (id, decisionId) => join(batchDir(id), "decisions", `${decisionId}.json`),
    answer: (id, decisionId) => join(batchDir(id), "answers", `${decisionId}.json`),
    claim: (repoKey, key) => join(root, "claims", repoKey, `${key}.json`),
    claimDir: (repoKey) => join(root, "claims", repoKey),
  };
}

/** Reads a store file as text, or null when it is missing. */
export async function readStoreText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function parseObject(text, file) {
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Batch record is not valid JSON: ${file}`);
  }
  if (!isJsonObject(value)) {
    throw new Error(`Batch record is not a JSON object: ${file}`);
  }
  return value;
}

/** Reads and validates one batch manifest, or null when it is missing. */
export async function readManifest(runsRoot, id) {
  const file = batchPaths(runsRoot).manifest(id);
  return parseObject(await readStoreText(file), file);
}

/** Reads and validates one loop checkpoint, or null when it is missing. */
export async function readLoop(runsRoot, id, issue) {
  const file = batchPaths(runsRoot).loop(id, issue);
  return parseObject(await readStoreText(file), file);
}

/** The local batches, newest first. A missing store has none. */
export async function listBatches(runsRoot) {
  const { root } = batchPaths(runsRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const batches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "claims") continue;
    try {
      const manifest = await readManifest(runsRoot, entry.name);
      if (manifest !== null) batches.push(manifest);
    } catch {
      // A directory that holds no readable manifest is not a batch this reader reports.
    }
  }
  return batches.sort((a, b) => {
    const left = String(a.createdAt ?? "");
    const right = String(b.createdAt ?? "");
    return left === right ? String(b.id).localeCompare(String(a.id)) : right.localeCompare(left);
  });
}

/** Writes the manifest and each queued loop of a new batch. */
export async function createBatchStore(runsRoot, manifest, loops) {
  const paths = batchPaths(runsRoot);
  await mkdir(join(paths.batchDir(manifest.id), "loops"), { recursive: true });
  await mkdir(join(paths.batchDir(manifest.id), "transcripts"), { recursive: true });
  await mkdir(join(paths.batchDir(manifest.id), "logs"), { recursive: true });
  await writeFileAtomic(paths.manifest(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const loop of loops) {
    await writeFileAtomic(
      paths.loop(manifest.id, loop.issue),
      `${JSON.stringify(loop, null, 2)}\n`,
    );
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Reads one loop checkpoint, hands it to `updater`, and writes the result only when it differs.
 * Returns true when a write happened. The read-modify-write runs under the one batch lock, so two
 * batch commands cannot interleave a checkpoint change.
 */
export async function updateLoop(runsRoot, id, issue, updater) {
  const paths = batchPaths(runsRoot);
  return serialized(paths.lock(id), () =>
    withStateLock(
      paths.lock(id),
      async () => {
        const file = paths.loop(id, issue);
        const current = parseObject(await readStoreText(file), file);
        if (current === null) throw new Error(`No loop checkpoint for issue ${issue}.`);
        const next = await updater(current);
        if (next === undefined || next === null || same(next, current)) return false;
        await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
        return true;
      },
      { label: "Batch", noun: "batch" },
    ),
  );
}

/** As `updateLoop`, for the batch manifest. Returns true when a write happened. */
export async function updateManifest(runsRoot, id, updater) {
  const paths = batchPaths(runsRoot);
  return serialized(paths.lock(id), () =>
    withStateLock(
      paths.lock(id),
      async () => {
        const file = paths.manifest(id);
        const current = parseObject(await readStoreText(file), file);
        if (current === null) throw new Error(`No batch manifest for ${id}.`);
        const next = await updater(current);
        if (next === undefined || next === null || same(next, current)) return false;
        await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
        return true;
      },
      { label: "Batch", noun: "batch" },
    ),
  );
}

/**
 * Reads a claim. `held` is true for a live owner and for an unparseable file, because a partial
 * write may still be in progress. A parsed record carries `live`.
 */
export async function readClaim(runsRoot, repoKey, issue) {
  const file = batchPaths(runsRoot).claim(repoKey, issue);
  const text = await readStoreText(file);
  if (text === null) return { exists: false, held: false, parsed: false };
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { exists: true, held: true, parsed: false, text };
  }
  if (
    !isJsonObject(record) ||
    !Number.isInteger(record.pid) ||
    typeof record.batchId !== "string"
  ) {
    return { exists: true, held: true, parsed: false, text };
  }
  const live = await ownerAlive(record);
  return {
    exists: true,
    held: live,
    live,
    parsed: true,
    record,
    text,
  };
}

/** Writes `text` to `file` only when the file does not exist. Returns false when it exists. */
export async function createExclusive(file, text) {
  await mkdir(join(file, ".."), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    try {
      await link(temp, file);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      if (!LINK_UNSUPPORTED.has(err.code)) throw err;
      try {
        await writeFile(file, text, { encoding: "utf8", flag: "wx" });
        return true;
      } catch (openErr) {
        if (openErr.code === "EEXIST") return false;
        throw openErr;
      }
    }
  } finally {
    await removeTemp(temp);
  }
}

async function removeClaimText(file, text) {
  return serialized(`${file}.lock`, () =>
    withStateLock(
      `${file}.lock`,
      async () => {
        if ((await readStoreText(file)) !== text) return false;
        await rm(file, { force: true });
        return true;
      },
      { label: "Issue claim", noun: "issue claim" },
    ),
  );
}

/**
 * Acquires the claim of one repository and issue with an exclusive create. A live or
 * unparseable claim is kept. A dead owner's claim is removed only when `onStale(record)` returns
 * true, and then only if the file still holds the same content.
 * @returns {Promise<{ acquired: boolean, record?: object, held?: boolean, stale?: boolean, owner?: string }>}
 */
export async function acquireClaim(runsRoot, repoKey, issue, record, { onStale = null } = {}) {
  const file = batchPaths(runsRoot).claim(repoKey, issue);
  const full = {
    batchId: record.batchId,
    issue,
    repo: record.repo ?? null,
    workTree: record.workTree ?? null,
    pid: record.pid,
    startTime: record.startTime ?? null,
    createdAt: new Date().toISOString(),
  };
  const text = `${JSON.stringify(full, null, 2)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createExclusive(file, text)) {
      return { acquired: true, record: full };
    }
    const current = await readClaim(runsRoot, repoKey, issue);
    if (current.parsed && current.live === false && onStale && (await onStale(current.record))) {
      await removeClaimText(file, current.text);
      continue;
    }
    return {
      acquired: false,
      held: true,
      stale: current.parsed ? current.live === false : false,
      owner: current.record?.batchId ?? null,
    };
  }
  return { acquired: false, held: true };
}

/** Releases a claim that this batch owns. A missing, unparseable, or foreign claim is kept. */
export async function releaseClaim(runsRoot, repoKey, issue, { batchId }) {
  const file = batchPaths(runsRoot).claim(repoKey, issue);
  const text = await readStoreText(file);
  if (text === null) return false;
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isJsonObject(record) || record.batchId !== batchId) return false;
  return removeClaimText(file, text);
}

/** Removes a claim of this batch regardless of liveness, for a documented terminal outcome. */
export async function dropClaim(runsRoot, repoKey, issue, { batchId }) {
  return releaseClaim(runsRoot, repoKey, issue, { batchId });
}
