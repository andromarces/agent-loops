// OpenCode parent-edit guard (#75), the OpenCode counterpart of the Claude Code
// PreToolUse hook (#57). OpenCode ships no session placeholder for Markdown
// command templates, so the plugin channel supplies the session id: a plugin
// command reads `CommandInvocation.sessionID` and passes it to the parent, and a
// permission hook reads `PermissionEvaluation.sessionID` and denies file edits
// from the registered parent while its run is non-terminal. Both paths reuse the
// shared decision logic (`src/hook/decision.mjs`), so the OpenCode guard matches
// `decideParentGuard` exactly. Fail-open by design: every other session, every
// terminal lifecycle, and every absent or corrupt record allows the call.
//
// The guard resolves the runs root from this server process's environment, so
// an out-of-process `AGENT_LOOP_RUNS_ROOT` override (test-only) would desync
// it from the `agent-loop` CLI that wrote the index.
import { decideParentGuard } from "../../src/hook/decision.mjs";

// The permission actions that carry a file edit. A set, not a single constant,
// so a further edit tool is one entry. A live probe against OpenCode
// v0.0.0-dev-19933 showed the built-in `edit`, `write`, and `apply_patch` tools
// all raise the `edit` action, so the set covers every built-in file-edit tool.
// `shell` is a different action and stays allowed. A tool served by an MCP
// server raises its own action name and passes the guard.
export const EDIT_ACTIONS = new Set(["edit"]);
const COMMAND_NAME = "agent-loop";

const INSTRUCTIONS = (sessionID, task) =>
  [
    "Read `docs/orchestrator-instructions.md` and follow it for this request.",
    "The task and role settings are:",
    task,
    `This OpenCode session id is \`${sessionID}\`. Pass it as \`--parent-session\` on the init dispatch call.`,
  ].join("\n\n");

export default {
  id: "agent-loop.parent-guard",
  async setup(ctx) {
    // Registers the entry point. The stored Markdown template cannot receive the
    // parent session id, so the plugin command injects it into the orchestrator
    // prompt instead.
    await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND_NAME,
        description:
          "Run a delegated agent-loop role orchestration through the agent-loop CLI (rules in docs/orchestrator-instructions.md).",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: INSTRUCTIONS(sessionID, prompt.text),
            delivery,
          });
        },
      });
    });

    // Denies a file edit from the registered parent while the run is
    // non-terminal. A failed lookup denies nothing.
    await ctx.permission.hook("evaluate", async (event) => {
      if (!EDIT_ACTIONS.has(event.action) || typeof event.sessionID !== "string") {
        return;
      }
      let verdict;
      try {
        verdict = await decideParentGuard(event.sessionID);
      } catch {
        return;
      }
      if (verdict.decision === "deny") {
        event.effect = "deny";
        event.message = verdict.reason;
      }
    });
  },
};
