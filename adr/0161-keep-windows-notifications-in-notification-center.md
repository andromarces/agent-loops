# 0161. Keep Windows batch notifications in Notification Center

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md). The replaced part is the Windows notifier mechanics of decision 6: the tray balloon, its icon, and the wait that precedes the disposal. The rest of decision 6, including the macOS command, the environment-value rule, the text bound, the process bound, and the warning-only failure, and every other decision, consequence, and acceptance check stays in force.

## Date

2026-11-15

## Context

Decision 6 sent the Windows notification through a `System.Windows.Forms.NotifyIcon` balloon. The
script waited 300 ms and called `$icon.Dispose()`. Windows 11 converts that balloon into a toast
bound to the tray icon, and the disposal removes the toast from Notification Center.

The owner therefore missed a batch that waited on a decision or a merge. With Do Not Disturb off,
the banner showed and left no Notification Center entry. With Do Not Disturb on, no banner showed
and no entry remained. Three probes on Windows 11 on 2026-11-15 returned `{ spawned: true, ok: true }`
while the entry was absent.

## Decision

1. **A WinRT toast replaces the tray balloon.** The Windows script loads
   `Windows.UI.Notifications.ToastNotificationManager` through the WinRT projection of Windows
   PowerShell 5.1 (`powershell.exe`) and shows a `ToastText02` toast. The shell owns the toast
   record, so the entry stays in Notification Center after the notifier process exits. A suppressed
   banner under Do Not Disturb leaves the entry listed.
2. **The AppUserModelID is the Windows PowerShell Start menu id.**
   `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe` is registered by
   default on a Windows installation, and `CreateToastNotifier` shows nothing for an unregistered
   id. The known limits are that the entry is attributed to Windows PowerShell in Settings, that it
   carries the Windows PowerShell name and icon, and that the id is shared with every other toast
   that uses it. A Windows installation without that Start menu entry shows no toast, and the
   script then exits nonzero.
3. **The title and text enter through the DOM.** Both values arrive only as the environment values
   `AL_BATCH_NOTIFY_TITLE` and `AL_BATCH_NOTIFY_TEXT`, as decision 6 requires. The script appends a
   `CreateTextNode` value to each template text node, so no value becomes script source or XML
   markup. A quote, `$(...)`, `<`, `&`, and `]]>` stay text.
4. **The wait and the disposal are gone.** The toast needs no visible icon and no sleep before the
   exit. The invocation keeps the process bound of decision 6, and a WinRT type load or `Show`
   failure exits nonzero, so `notify()` warns and its `{ spawned, ok }` contract is unchanged.

## Consequences

- A batch notification that the owner sees neither as a banner nor at once is still listed in
  Notification Center.
- The notification is attributed to Windows PowerShell, and the text is bounded by the same length
  rule.
- A missing WinRT type, a missing Start menu id, and a refused `Show` remain warnings, never a batch
  failure or a stalled batch.
- The script holds no text, so a value with markup characters changes neither the script nor the
  toast XML.

## Alternatives

1. **Keep the balloon and delay the disposal.** Rejected. The toast stays bound to the icon, so the
   entry leaves Notification Center when the process ends, however long the wait.
2. **Register a dedicated AppUserModelID at run time.** Rejected. It writes a Start menu shortcut to
   the machine for one notification and needs a dependency or a shell link.
3. **Build the toast XML as a string.** Rejected. It interpolates the text into markup, and `]]>` or
   `<` would change the document.
4. **Send a detached notifier.** Rejected. Decision 6 bounds the notifier with one child and its
   timeout, and a detached process outlives the bound.

## Links

- [Issue #1984: Keep Windows batch notifications in Notification Center](https://github.com/andromarces/agent-loops/issues/1984)
- [PR #1985: Keep Windows batch notifications in Notification Center](https://github.com/andromarces/agent-loops/pull/1985)
- [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md)
- [Implementation: batch notifier](../src/batch/notifier.mjs)
- [Tests: batch notifier](../tests/batch/notifier.test.mjs)
- [ADR Index](README.md)
