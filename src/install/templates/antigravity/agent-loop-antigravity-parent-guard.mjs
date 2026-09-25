// Agent-loop Antigravity parent-guard hook shim (#88). Install copies this file
// beside `hooks.json` in the global `~/.gemini/config/` folder, and the named
// `agent-loop-parent-guard` `PreToolUse` group runs it by relative path.
// Antigravity runs the hook command without a shell and resolves it against
// that folder, so a quoted or spaced absolute script path fails. The shim
// loads the guard from the installed package, whose path may contain spaces,
// through a file URL. Install renders the import below to that absolute URL.
try {
  await import("__AGENT_LOOP_GUARD_URL__");
} catch {
  // A stale or unreachable guard URL denies nothing. A thrown import exits
  // non-zero, and Antigravity blocks the tool call on a non-zero exit, so the
  // failure is swallowed to keep the permission flow intact for every session.
}
