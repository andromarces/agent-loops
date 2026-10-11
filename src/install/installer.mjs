// `agent-loop install` / `agent-loop uninstall` (#139). User-scope only: each
// harness gets its entry point and its guard, rendered from the shipped
// templates against the installed package. The manifest records one baseline
// per target; a second install is a no-op, an upgrade replaces only the
// recorded entry, and uninstall restores the pre-install bytes when the file is
// unchanged since install. Guards are applied before entry points, and a failed
// write persists the manifest for the writes that completed and keeps the
// previous record for every target it did not complete, so uninstall can recover
// a partial install or an interrupted upgrade (#156). An exclusive lock
// beside `<home>/.agent-loops` serializes install and uninstall, so concurrent
// read-modify-write of the manifest cannot drop a record, whatever the temp
// root of each process (#193, #198).
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { readableErrorText } from "../lib/error-message.mjs";
import { logWarn, logWarnFull } from "../lib/log.mjs";
import { withStateLock } from "../lib/runstate.mjs";
import {
  backupPathFor,
  ensureDir,
  fileMode,
  pruneEmptyDirs,
  readTextOrNull,
  removeFileQuiet,
  sha256,
  writeTextAtomic,
} from "./fsutil.mjs";
import { HARNESS_META, HARNESS_ORDER } from "../lib/harnesses.mjs";
import { buildTargets } from "./harnesses.mjs";
import { EPHEMERAL_ROOT_MESSAGE, isEphemeralPackageRoot } from "./package-root.mjs";
import {
  manifestLockFile,
  manifestPath,
  readManifest,
  removeManifest,
  resolveHome,
  writeManifest,
} from "./manifest.mjs";
import {
  findEntryIndex,
  insertEntry,
  manualSnippet,
  missingLocatorIndex,
  parseSettings,
  pruneEmptyLocator,
  removeEntry,
  replaceEntry,
  serializeSettings,
  validateLocator,
} from "./settings.mjs";

function planBackup(target, previous, current) {
  const existedBefore = previous ? previous.existedBefore : current !== null;
  const backupPath = previous?.backupPath ?? null;
  const backup =
    existedBefore && !backupPath && current !== null
      ? { path: backupPathFor(target.path), content: current }
      : null;
  return { existedBefore, backupPath, backup };
}

async function planFileWrite(target, previous) {
  const current = await readTextOrNull(target.path);
  const currentSha = current === null ? null : sha256(current);
  const desiredSha = sha256(target.content);

  if (previous && currentSha !== null && currentSha !== previous.shaAfter) {
    if (currentSha === desiredSha) {
      return { kind: "file", action: "noop", path: target.path, record: previous };
    }
    return {
      kind: "file",
      action: "skip",
      path: target.path,
      detail: "owned file changed since install; left unchanged",
      record: previous,
    };
  }

  if (currentSha === desiredSha) {
    const record = previous ?? {
      kind: "file",
      path: target.path,
      existedBefore: current !== null,
      shaBefore: currentSha,
      shaAfter: desiredSha,
      backupPath: null,
    };
    return { kind: "file", action: "noop", path: target.path, record };
  }

  const { existedBefore, backupPath, backup } = planBackup(target, previous, current);
  return {
    kind: "file",
    action: existedBefore ? "update" : "create",
    path: target.path,
    content: target.content,
    backup,
    record: {
      kind: "file",
      path: target.path,
      existedBefore,
      shaBefore: previous ? previous.shaBefore : currentSha,
      shaAfter: desiredSha,
      backupPath: backup ? backup.path : backupPath,
    },
  };
}

async function planSettingsWrite(target, previous) {
  const current = await readTextOrNull(target.path);
  const currentSha = current === null ? null : sha256(current);
  const snippet = manualSnippet(target.path, target.locator, target.entry);

  let settings;
  try {
    settings = current === null ? {} : parseSettings(current, target.path);
  } catch (err) {
    return {
      kind: "settings",
      action: "refuse",
      path: target.path,
      detail: readableErrorText(err),
      snippet,
    };
  }

  const shape = validateLocator(settings, target.locator);
  if (!shape.ok) {
    return {
      kind: "settings",
      action: "refuse",
      path: target.path,
      detail: `settings file has an unexpected shape: ${shape.reason}`,
      snippet,
    };
  }

  let createdFrom = previous?.createdFrom;
  if (previous) {
    if (findEntryIndex(settings, previous.locator, previous.entry) === -1) {
      return {
        kind: "settings",
        action: "skip",
        path: target.path,
        detail: "recorded entry not found; the user changed or removed it",
        snippet,
        record: previous,
      };
    }
    replaceEntry(settings, target.locator, previous.entry, target.entry);
  } else {
    createdFrom = missingLocatorIndex(settings, target.locator);
    const result = insertEntry(settings, target.locator, target.entry);
    if (result.status === "conflict") {
      return {
        kind: "settings",
        action: "skip",
        path: target.path,
        detail: "the named hook group already exists with different content",
        snippet,
      };
    }
    if (result.status === "duplicate") {
      // The exact guard entry is already present but unowned. The guard is
      // installed, so do not block the entry point; leave the entry unrecorded
      // and uninstall never removes it.
      return {
        kind: "settings",
        action: "noop",
        path: target.path,
        detail: "an identical guard entry is already present; left unowned",
      };
    }
  }

  const text = serializeSettings(settings, current);
  const desiredSha = sha256(text);

  if (currentSha === desiredSha) {
    // No write: the current bytes already carry the desired entry. Keep the
    // previous record, because its post-install hash may not match a file the
    // user edited since install; advancing the hash would make uninstall treat
    // those edits as installer-owned and restore the backup over them.
    return {
      kind: "settings",
      action: "noop",
      path: target.path,
      record: previous ?? undefined,
    };
  }

  const { existedBefore, backupPath, backup } = planBackup(target, previous, current);
  // A write that starts from bytes other than the recorded post-install hash
  // includes user edits. Mark the record so uninstall removes only the entry
  // instead of restoring the backup over them.
  const userEdited =
    Boolean(previous && previous.shaAfter !== currentSha) || Boolean(previous?.userEdited);
  const record = {
    kind: "settings",
    path: target.path,
    locator: target.locator,
    entry: target.entry,
    existedBefore,
    shaBefore: previous ? previous.shaBefore : currentSha,
    shaAfter: desiredSha,
    backupPath: backup ? backup.path : backupPath,
    userEdited,
    createdFrom: createdFrom ?? 0,
  };

  return {
    kind: "settings",
    action: existedBefore ? "update" : "create",
    path: target.path,
    content: text,
    backup,
    record,
  };
}

async function applyWrite(plan, { dryRun, dirs, write }) {
  if (dryRun || !plan.content) {
    return;
  }
  await ensureDir(dirname(plan.path), dirs);
  const mode = (await fileMode(plan.path)) ?? undefined;
  if (plan.backup) {
    await write(plan.backup.path, plan.backup.content, { mode });
  }
  try {
    await write(plan.path, plan.content, { mode });
  } catch (err) {
    // The target kept its original bytes, so the backup just written is
    // unneeded. Remove it before the error propagates. A cleanup failure
    // becomes a warning and never replaces the write error.
    if (plan.backup) {
      await removeFileQuiet(plan.backup.path).catch((cleanupErr) => {
        logWarnFull(
          `could not remove the backup after a failed write (${readableErrorText(cleanupErr)}). ` +
            `Remove the backup file by hand: ${plan.backup.path}`,
        );
      });
    }
    throw err;
  }
}

function report(harness, plan) {
  return {
    harness,
    kind: plan.kind,
    action: plan.action,
    path: plan.path,
    ...(plan.detail ? { detail: plan.detail } : {}),
    ...(plan.snippet ? { snippet: plan.snippet } : {}),
  };
}

/**
 * Adds the previous record for every target without a record yet. A failed
 * install leaves the bytes those targets held before, so uninstall must keep
 * owning them (#156).
 */
function keepPriorRecords(records, targets, priorRecords) {
  for (const target of targets) {
    if (records.some((record) => record.path === target.path)) {
      continue;
    }
    const prior = priorRecords?.find((record) => record.path === target.path);
    if (prior) {
      records.push(prior);
    }
  }
}

/**
 * Installs one or more harnesses at user scope under the manifest lock. A dry
 * run takes no lock and writes nothing.
 * @returns {Promise<Array<{harness: string, kind: string, action: string, path: string, detail?: string, snippet?: string}>>}
 */
export async function install(options = {}) {
  const home = options.home ?? resolveHome();
  if (typeof options.packageRoot === "string" && isEphemeralPackageRoot(options.packageRoot)) {
    throw new Error(EPHEMERAL_ROOT_MESSAGE);
  }
  if (options.dryRun) {
    return runInstall(options);
  }
  return withStateLock(manifestLockFile(home), () => runInstall(options), {
    label: "The install manifest",
    noun: "install manifest",
  });
}

/** Runs the install once the caller owns the manifest lock, or for a dry run. */
async function runInstall({
  harnesses,
  home = resolveHome(),
  packageRoot,
  copilotHome = process.env.COPILOT_HOME,
  dryRun = false,
  write = writeTextAtomic,
} = {}) {
  const manifest = await readManifest(home);
  const plans = [];
  let refusal = null;

  // Plan every write before any write. An unparseable settings file stops the
  // command with no write at all.
  for (const harness of harnesses) {
    const targets = await buildTargets(harness, { home, packageRoot, copilotHome });
    const previous = manifest.harnesses[harness] ?? null;
    const entry = {
      harness,
      previous,
      dirs: new Set(previous?.dirs ?? []),
      files: [],
      settings: [],
    };
    for (const file of targets.files) {
      const prior = previous?.files?.find((record) => record.path === file.path) ?? null;
      entry.files.push({ path: file.path, plan: await planFileWrite(file, prior) });
    }
    for (const target of targets.settings) {
      const prior = previous?.settings?.find((record) => record.path === target.path) ?? null;
      const plan = await planSettingsWrite(target, prior);
      if (plan.action === "refuse" && !refusal) {
        refusal = plan;
      }
      entry.settings.push({ path: target.path, plan });
    }

    // No harness installs an entry point without its guard. When a settings
    // target cannot be merged (a conflicting key, or a recorded entry the user
    // removed), leave every entry-point file for that harness unchanged.
    const guardBlocked = entry.settings.some(
      ({ plan }) => plan.action === "skip" || plan.action === "refuse",
    );
    if (guardBlocked) {
      entry.files = entry.files.map(({ path }) => {
        const prior = previous?.files?.find((record) => record.path === path) ?? null;
        return {
          path,
          plan: {
            kind: "file",
            action: "skip",
            path,
            detail: "guard settings were not installed; entry point left unchanged",
            record: prior ?? undefined,
          },
        };
      });
    }
    plans.push(entry);
  }

  if (refusal && !dryRun) {
    const error = new Error(refusal.detail);
    error.path = refusal.path;
    error.snippet = refusal.snippet;
    throw error;
  }

  const reports = [];
  let active = null;
  try {
    for (const entry of plans) {
      active = entry;
      const record = { files: [], settings: [], dirs: entry.previous?.dirs ?? [] };
      // Record the harness before its first write. A failure mid-harness then
      // still leaves a manifest record that uninstall can act on.
      if (!dryRun) {
        manifest.harnesses[entry.harness] = record;
      }
      // Guard settings first: an entry point never lands without its guard,
      // even when a later write fails.
      for (const { plan } of entry.settings) {
        await applyWrite(plan, { dryRun, dirs: entry.dirs, write });
        if (plan.record) {
          record.settings.push(plan.record);
        }
        reports.push(report(entry.harness, plan));
      }
      for (const { plan } of entry.files) {
        await applyWrite(plan, { dryRun, dirs: entry.dirs, write });
        if (plan.record) {
          record.files.push(plan.record);
        }
        reports.push(report(entry.harness, plan));
      }
      record.dirs = [...entry.dirs];
      active = null;
    }
  } catch (err) {
    if (!dryRun) {
      // Persist the completed writes before the error propagates, so uninstall
      // restores every file this partial install touched, including the
      // completed writes of earlier harnesses.
      if (active) {
        const record = manifest.harnesses[active.harness];
        if (record) {
          record.dirs = [...active.dirs];
          // A target this install did not complete, including one an upgrade
          // never reached, keeps its previous record so uninstall still owns
          // the bytes the failed install left in place.
          keepPriorRecords(record.settings, active.settings, active.previous?.settings);
          keepPriorRecords(record.files, active.files, active.previous?.files);
        }
      }
      await writeManifest(home, manifest).catch((saveError) => {
        logWarn(
          `install failed and the manifest could not be saved (${saveError.message}); ` +
            "uninstall cannot undo the completed writes",
        );
      });
    }
    throw err;
  }

  // Codex notes precede Claude notes whatever order the harnesses were selected in.
  for (const harness of [...HARNESS_ORDER].reverse()) {
    if (!harnesses.includes(harness)) {
      continue;
    }
    for (const note of HARNESS_META[harness].notes ?? []) {
      if (dryRun && !note.dryRun) {
        continue;
      }
      reports.push({
        harness,
        kind: "settings",
        action: "note",
        path: join(home, ...note.path),
        detail: note.detail,
      });
    }
  }

  if (!dryRun) {
    await writeManifest(home, manifest);
  }
  return reports;
}

function uninstallReport(record, kind, action, detail) {
  const report = { harness: record.harness, kind, action, path: record.path };
  if (detail !== undefined) {
    report.detail = detail;
  }
  return report;
}

async function restoreOrDelete(record, kind, dryRun) {
  if (record.existedBefore) {
    const backupFile = record.backupPath ?? backupPathFor(record.path);
    const backup = await readTextOrNull(backupFile, { notDirIsMissing: true });
    if (backup === null) {
      return uninstallReport(record, kind, "skip", "backup missing; left unchanged");
    }
    if (!dryRun) {
      await writeTextAtomic(record.path, backup, {
        mode: (await fileMode(backupFile)) ?? undefined,
      });
      await removeFileQuiet(backupFile);
    }
    return uninstallReport(record, kind, "restore");
  }
  if (!dryRun) {
    await removeFileQuiet(record.path);
  }
  return uninstallReport(record, kind, "delete");
}

async function planSettingsRestore(record, dryRun) {
  const current = await readTextOrNull(record.path, { notDirIsMissing: true });
  if (current === null) {
    return uninstallReport(record, "settings", "missing");
  }
  const currentSha = sha256(current);

  if (currentSha === record.shaAfter && !record.userEdited) {
    return restoreOrDelete(record, "settings", dryRun);
  }

  let settings;
  try {
    settings = parseSettings(current, record.path);
  } catch {
    return uninstallReport(record, "settings", "skip", "settings do not parse; left unchanged");
  }
  if (!removeEntry(settings, record.locator, record.entry)) {
    return uninstallReport(record, "settings", "skip", "recorded entry not found; left unchanged");
  }
  pruneEmptyLocator(settings, record.locator, record.createdFrom ?? 0);
  if (!record.existedBefore && Object.keys(settings).length === 0) {
    // Install created this file and the user edited nothing else, so removing
    // the entry empties it. Delete it instead of leaving `{}`.
    if (!dryRun) {
      await removeFileQuiet(record.path);
    }
    return uninstallReport(record, "settings", "delete");
  }
  if (!dryRun) {
    await writeTextAtomic(record.path, serializeSettings(settings, current));
  }
  return uninstallReport(
    record,
    "settings",
    "remove-entry",
    "the file changed after install; removed only the recorded entry, so the result is not byte-identical",
  );
}

async function planFileRestore(record, dryRun) {
  const current = await readTextOrNull(record.path, { notDirIsMissing: true });
  if (current === null) {
    return uninstallReport(record, "file", "missing");
  }
  if (sha256(current) !== record.shaAfter) {
    return uninstallReport(
      record,
      "file",
      "skip",
      "owned file changed since install; left unchanged",
    );
  }
  return restoreOrDelete(record, "file", dryRun);
}

/**
 * Removes every target the manifest records for the selected harnesses under
 * the manifest lock. A dry run takes no lock and writes nothing. If lstat of the
 * home reports ENOENT, for any reason, the call takes no lock, reads and writes
 * nothing, reports nothing to remove, and never creates the home. That includes
 * a Windows path that cannot name a directory: no install can exist there, so no
 * data is lost, and it no longer raises an error (maintainer
 * decision, issue #570). An install that creates the home after that check runs
 * after this uninstall returned, as if the uninstall had come first. Any other
 * lstat error takes the locked path, so no branch mutates without the lock.
 */
export async function uninstall(options = {}) {
  const home = options.home ?? resolveHome();
  if (homeIsMissing(home)) {
    return [];
  }
  if (options.dryRun) {
    return runUninstall(options);
  }
  return withStateLock(manifestLockFile(home), () => runUninstall(options), {
    label: "The install manifest",
    noun: "install manifest",
  });
}

function homeIsMissing(home) {
  try {
    lstatSync(home);
    return false;
  } catch (err) {
    return err?.code === "ENOENT";
  }
}

/** Runs the uninstall once the caller owns the manifest lock, or for a dry run. */
async function runUninstall({ harnesses, home = resolveHome(), dryRun = false } = {}) {
  const manifest = await readManifest(home);
  const selected = (harnesses ?? HARNESS_ORDER).filter((harness) => manifest.harnesses[harness]);
  const reports = [];

  for (const harness of selected) {
    const record = manifest.harnesses[harness];
    for (const settings of record.settings ?? []) {
      reports.push(await planSettingsRestore({ ...settings, harness }, dryRun));
    }
    for (const file of record.files ?? []) {
      reports.push(await planFileRestore({ ...file, harness }, dryRun));
    }
    if (!dryRun) {
      let pruned;
      try {
        pruned = await pruneEmptyDirs(record.dirs ?? []);
      } catch (err) {
        // The file and settings targets above were already restored or
        // deleted, so keep only the directory list. Their stale records would
        // make the next install read a missing recorded entry and skip the
        // whole harness, while the directory still needs a later retry.
        manifest.harnesses[harness] = { dirs: record.dirs ?? [] };
        reports.push({
          harness,
          kind: "dir",
          action: "failed",
          path: err.path,
          detail:
            `the directory could not be removed (${err.code}); ` +
            "kept for a later uninstall to retry",
        });
        continue;
      }
      for (const dir of pruned.notDirs) {
        reports.push({
          harness,
          kind: "dir",
          action: "skip",
          path: dir,
          detail: "not a directory; left in place",
        });
      }
      // A record kept only for its directories has no file or settings report,
      // so name each directory this retry removed, or the cleared record when
      // none remained, instead of printing nothing.
      if ((record.files ?? []).length === 0 && (record.settings ?? []).length === 0) {
        for (const dir of pruned.removed) {
          reports.push({ harness, kind: "dir", action: "delete", path: dir });
        }
        if (pruned.removed.length === 0 && pruned.notDirs.length === 0) {
          reports.push({
            harness,
            kind: "record",
            action: "clear",
            path: manifestPath(home),
            detail: "record kept only for directories; none left to remove",
          });
        }
      }
    }
    delete manifest.harnesses[harness];
  }

  if (!dryRun) {
    if (Object.keys(manifest.harnesses).length === 0) {
      await removeManifest(home);
    } else {
      await writeManifest(home, manifest);
    }
  }
  return reports;
}
