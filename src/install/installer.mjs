// `agent-loop install` / `agent-loop uninstall` (#139). User-scope only: each
// harness gets its entry point and its guard, rendered from the shipped
// templates against the installed package. The manifest records one baseline
// per target; a second install is a no-op, an upgrade replaces only the
// recorded entry, and uninstall restores the pre-install bytes when the file is
// unchanged since install.
import { access } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
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
import { buildTargets, HARNESS_META, HARNESS_ORDER } from "./harnesses.mjs";
import { readManifest, removeManifest, resolveHome, writeManifest } from "./manifest.mjs";
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

  const existedBefore = previous ? previous.existedBefore : current !== null;
  const backupPath = previous?.backupPath ?? null;
  const backup =
    existedBefore && !backupPath && current !== null
      ? { path: backupPathFor(target.path), content: current }
      : null;
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
    return { kind: "settings", action: "refuse", path: target.path, detail: err.message, snippet };
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

  const existedBefore = previous ? previous.existedBefore : current !== null;
  const backupPath = previous?.backupPath ?? null;
  const backup =
    existedBefore && !backupPath && current !== null
      ? { path: backupPathFor(target.path), content: current }
      : null;
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

async function applyWrite(plan, { dryRun, dirs }) {
  if (dryRun || !plan.content) {
    return;
  }
  await ensureDir(dirname(plan.path), dirs);
  const mode = (await fileMode(plan.path)) ?? undefined;
  if (plan.backup) {
    await writeTextAtomic(plan.backup.path, plan.backup.content, { mode });
  }
  await writeTextAtomic(plan.path, plan.content, { mode });
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
 * Installs one or more harnesses at user scope.
 * @returns {Promise<Array<{harness: string, kind: string, action: string, path: string, detail?: string, snippet?: string}>>}
 */
export async function install({
  harnesses,
  home = resolveHome(),
  packageRoot,
  copilotHome = process.env.COPILOT_HOME,
  dryRun = false,
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
  for (const entry of plans) {
    const record = { files: [], settings: [], dirs: entry.previous?.dirs ?? [] };
    for (const { plan } of entry.files) {
      await applyWrite(plan, { dryRun, dirs: entry.dirs });
      if (plan.record) {
        record.files.push(plan.record);
      }
      reports.push(report(entry.harness, plan));
    }
    for (const { plan } of entry.settings) {
      await applyWrite(plan, { dryRun, dirs: entry.dirs });
      if (plan.record) {
        record.settings.push(plan.record);
      }
      reports.push(report(entry.harness, plan));
    }
    record.dirs = [...entry.dirs];
    if (!dryRun) {
      manifest.harnesses[entry.harness] = record;
    }
  }

  if (harnesses.includes("codex")) {
    reports.push({
      harness: "codex",
      kind: "settings",
      action: "note",
      path: join(home, ".codex", "hooks.json"),
      detail:
        "Codex requires review and trust of each non-managed hook through /hooks. " +
        "A changed hook command needs a new trust step.",
    });
    if (!dryRun) {
      reports.push({
        harness: "codex",
        kind: "settings",
        action: "note",
        path: join(home, ".agents", "skills"),
        detail:
          "The Codex skill lives in the shared ~/.agents/skills directory, which " +
          "GitHub Copilot CLI and OpenCode also discover. The skill sets " +
          "`metadata.opencode/autoinvoke: false`, so OpenCode drops it from the " +
          "model's skill list and the OpenCode plugin command owns /agent-loop. " +
          "The skill also runs the installed CLI by absolute path with " +
          "`harness-check codex` and refuses to start from a Copilot or OpenCode " +
          "session.",
      });
    }
  }

  if (harnesses.includes("claude") && !dryRun) {
    reports.push({
      harness: "claude",
      kind: "settings",
      action: "note",
      path: join(home, ".claude", "skills"),
      detail:
        "OpenCode also discovers ~/.claude/skills, so it lists the Claude skill " +
        "to the model. The skill sets `metadata.opencode/autoinvoke: false`, so " +
        "OpenCode drops it from the model's skill list and the OpenCode plugin " +
        "command owns /agent-loop. The skill also runs the installed CLI with " +
        "`harness-check claude` and refuses to start from a foreign session.",
    });
  }

  if (!dryRun) {
    await writeManifest(home, manifest);
  }
  return reports;
}

async function planSettingsRestore(record, dryRun) {
  const current = await readTextOrNull(record.path);
  if (current === null) {
    return { harness: record.harness, kind: "settings", action: "missing", path: record.path };
  }
  const currentSha = sha256(current);

  if (currentSha === record.shaAfter && !record.userEdited) {
    if (record.existedBefore) {
      const backupFile = record.backupPath ?? backupPathFor(record.path);
      const backup = await readTextOrNull(backupFile);
      if (backup === null) {
        return {
          harness: record.harness,
          kind: "settings",
          action: "skip",
          path: record.path,
          detail: "backup missing; left unchanged",
        };
      }
      if (!dryRun) {
        await writeTextAtomic(record.path, backup, {
          mode: (await fileMode(backupFile)) ?? undefined,
        });
        await removeFileQuiet(backupFile);
      }
      return { harness: record.harness, kind: "settings", action: "restore", path: record.path };
    }
    if (!dryRun) {
      await removeFileQuiet(record.path);
    }
    return { harness: record.harness, kind: "settings", action: "delete", path: record.path };
  }

  let settings;
  try {
    settings = parseSettings(current, record.path);
  } catch {
    return {
      harness: record.harness,
      kind: "settings",
      action: "skip",
      path: record.path,
      detail: "settings do not parse; left unchanged",
    };
  }
  if (!removeEntry(settings, record.locator, record.entry)) {
    return {
      harness: record.harness,
      kind: "settings",
      action: "skip",
      path: record.path,
      detail: "recorded entry not found; left unchanged",
    };
  }
  pruneEmptyLocator(settings, record.locator, record.createdFrom ?? 0);
  if (!record.existedBefore && Object.keys(settings).length === 0) {
    // Install created this file and the user edited nothing else, so removing
    // the entry empties it. Delete it instead of leaving `{}`.
    if (!dryRun) {
      await removeFileQuiet(record.path);
    }
    return { harness: record.harness, kind: "settings", action: "delete", path: record.path };
  }
  if (!dryRun) {
    await writeTextAtomic(record.path, serializeSettings(settings, current));
  }
  return {
    harness: record.harness,
    kind: "settings",
    action: "remove-entry",
    path: record.path,
    detail:
      "the file changed after install; removed only the recorded entry, so the result is not byte-identical",
  };
}

async function planFileRestore(record, dryRun) {
  const current = await readTextOrNull(record.path);
  if (current === null) {
    return { harness: record.harness, kind: "file", action: "missing", path: record.path };
  }
  if (sha256(current) !== record.shaAfter) {
    return {
      harness: record.harness,
      kind: "file",
      action: "skip",
      path: record.path,
      detail: "owned file changed since install; left unchanged",
    };
  }
  if (record.existedBefore) {
    const backupFile = record.backupPath ?? backupPathFor(record.path);
    const backup = await readTextOrNull(backupFile);
    if (backup === null) {
      return {
        harness: record.harness,
        kind: "file",
        action: "skip",
        path: record.path,
        detail: "backup missing; left unchanged",
      };
    }
    if (!dryRun) {
      await writeTextAtomic(record.path, backup, {
        mode: (await fileMode(backupFile)) ?? undefined,
      });
      await removeFileQuiet(backupFile);
    }
    return { harness: record.harness, kind: "file", action: "restore", path: record.path };
  }
  if (!dryRun) {
    await removeFileQuiet(record.path);
  }
  return { harness: record.harness, kind: "file", action: "delete", path: record.path };
}

/** Removes every target the manifest records for the selected harnesses. */
export async function uninstall({ harnesses, home = resolveHome(), dryRun = false } = {}) {
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
      await pruneEmptyDirs(record.dirs ?? []);
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

function executableCandidates(command) {
  if (process.platform !== "win32") {
    return [command];
  }
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

async function onPath(command) {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of executableCandidates(command)) {
      try {
        await access(join(dir, candidate));
        return true;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return false;
}

/** Harnesses whose CLI is found on PATH, in registry order. */
export async function detectHarnesses() {
  const detected = [];
  for (const harness of HARNESS_ORDER) {
    for (const command of HARNESS_META[harness].commands) {
      if (await onPath(command)) {
        detected.push(harness);
        break;
      }
    }
  }
  return detected;
}
