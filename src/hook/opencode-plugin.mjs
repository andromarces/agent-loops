// OpenCode parent-guard plugin factory (#75, packaged by #139). The shipped
// entry point is the rendered template at
// `src/install/templates/opencode/plugins/parent-guard.ts`, which imports this
// factory and the shared decision logic by absolute URL. Keeping the behavior
// here lets tests drive the same object the rendered plugin exports.
//
// OpenCode ships no session placeholder for Markdown command templates, so the
// plugin channel supplies the session id: a plugin command reads
// `CommandInvocation.sessionID` and passes it to the parent, and a permission
// hook reads `PermissionEvaluation.sessionID` and denies file edits from the
// registered parent while its run is non-terminal. Both paths reuse
// `decideParentGuard`, so the OpenCode guard matches it exactly. Fail-open by
// design: every other session, every terminal lifecycle, and every absent or
// corrupt record allows the call.
//
// The shared Claude and Codex skills set `metadata.opencode/autoinvoke: false`,
// so OpenCode drops them from the model's skill list and the model cannot
// auto-invoke one for an /agent-loop request. This command is then the only
// `/agent-loop` entry point that carries the OpenCode session id (#150).
//
// The guard resolves the runs root from this server process's environment, so
// an out-of-process `AGENT_LOOP_RUNS_ROOT` override (test-only) would desync
// it from the `agent-loop` CLI that wrote the index.

// The permission actions that carry a file edit. A set, not a single constant,
// so a further edit tool is one entry. A live probe against OpenCode
// v0.0.0-dev-19933 showed the built-in `edit`, `write`, and `apply_patch` tools
// all raise the `edit` action, so the set covers every built-in file-edit tool.
// `shell` is a different action and stays allowed. A tool served by an MCP
// server raises its own action name and passes the guard.
export const EDIT_ACTIONS = new Set(["edit"]);

/**
 * Builds the OpenCode plugin.
 * @param {{
 *   decideParentGuard: (sessionId: string) => Promise<{ decision: string, reason?: string }>,
 *   instructionsPath: string,
 * }} deps absolute path to the installed orchestrator instructions
 */
export function createParentGuardPlugin({ decideParentGuard, instructionsPath }) {
  const COMMAND_NAME = "agent-loop";

  const INSTRUCTIONS = (sessionID, task) =>
    [
      `Read \`${instructionsPath}\` and follow it for this request.`,
      "The task and role settings are:",
      task,
      `This OpenCode session id is \`${sessionID}\`. Pass it as \`--parent-session\` on the init dispatch call.`,
    ].join("\n\n");

  return {
    id: "agent-loop.parent-guard",
    async setup(ctx) {
      // Registers the entry point. The stored Markdown template cannot receive
      // the parent session id, so the plugin command injects it into the
      // orchestrator prompt instead.
      await ctx.command.transform((editor) => {
        editor.add({
          name: COMMAND_NAME,
          description:
            "Run a delegated agent-loop role orchestration through the agent-loop CLI (rules in the installed orchestrator instructions).",
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
}
