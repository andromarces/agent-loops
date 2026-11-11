// Desktop notifications of a batch (adr/0110-release-batch-slots-on-owner-decisions.md decision
// 6). The text reaches the command as an argument or an environment value, never inside the
// script. A missing binary, a failure, and a timeout only warn, so a notification never fails or
// stalls the batch.
import { execBounded } from "../lib/exec.mjs";
import { logWarn } from "../lib/log.mjs";

/** The longest notification text, in UTF-16 code units. */
export const NOTIFY_MAX_CHARS = 500;
/** The bound on one notifier process. */
const NOTIFY_TIMEOUT_MS = 5000;

// oxlint-disable-next-line no-control-regex -- the control characters are what the cleaning removes.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Removes control characters except a newline and a tab, and bounds the length. */
function cleanNotificationText(value) {
  return String(value ?? "")
    .replace(CONTROL, "")
    .slice(0, NOTIFY_MAX_CHARS);
}

const MAC_SCRIPT = [
  "on run argv",
  "  display notification (item 1 of argv) with title (item 2 of argv)",
  "end run",
].join("\n");

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$icon = New-Object System.Windows.Forms.NotifyIcon",
  "$icon.Icon = [System.Drawing.SystemIcons]::Information",
  "$icon.Visible = $true",
  "$icon.ShowBalloonTip(5000, $env:AL_BATCH_NOTIFY_TITLE, $env:AL_BATCH_NOTIFY_TEXT, [System.Windows.Forms.ToolTipIcon]::Info)",
  "Start-Sleep -Milliseconds 300",
  "$icon.Dispose()",
].join("\n");

/**
 * The command of one notification on `platform`, or null where the batch spawns nothing.
 * @returns {{ command: string, args: string[], env: Record<string, string> } | null}
 */
export function notificationInvocation({ title, text }, platform = process.platform) {
  const cleanTitle = cleanNotificationText(title);
  const cleanText = cleanNotificationText(text);
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", MAC_SCRIPT, cleanText, cleanTitle],
      env: {},
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
      env: { AL_BATCH_NOTIFY_TITLE: cleanTitle, AL_BATCH_NOTIFY_TEXT: cleanText },
    };
  }
  return null;
}

/**
 * Shows one notification. Never throws. Returns `{ spawned, ok }`, and `spawned` is false where
 * the platform has no notification command.
 */
export async function notify(
  { title, text },
  { platform = process.platform, execBounded: run = execBounded, logWarn: warn = logWarn } = {},
) {
  const invocation = notificationInvocation({ title, text }, platform);
  if (invocation === null) return { spawned: false, ok: true };
  let result;
  try {
    result = await run(invocation.command, invocation.args, {
      timeoutMs: NOTIFY_TIMEOUT_MS,
      env: invocation.env,
      stdin: "ignore",
      windowsHide: true,
    });
  } catch (err) {
    warn(`notification failed: ${err?.message ?? err}`);
    return { spawned: true, ok: false };
  }
  const ok = result?.exitCode === 0 && !result?.timedOut && !result?.isCanceled;
  if (!ok) warn("notification failed: the notifier exited nonzero, timed out, or was canceled");
  return { spawned: true, ok };
}
