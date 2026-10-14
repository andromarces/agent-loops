/**
 * Closing block every child turn must end with. The orchestrator sees only the child's final
 * response, so the block carries the reasoning and open items it would otherwise re-derive.
 */
export const reportBlock = `
End your response with this block, kept short. Each label takes one line, plain at column 0; a list anywhere in the block, an indented label, or a decorated label makes the whole block unparseable, and a line that starts with \`*\` either counts as a list or is dropped from the block, so write none:
Conclusion: one or two sentences.
Why: the decisive evidence behind the conclusion.
Blockers: anything unresolved that the next turn must know, or "none".
Checks: the commands that ran and their results, or "none". One line.
Notes: non-blocking findings the next turn does not need to act on, or "none".
Deferred: items found but left out of scope, or "none".
`.trim();

/**
 * Process rule for every worker and reviewer turn (issue #762). The dispatcher and the CLI of the
 * run carry the work tree path in their command lines, so a kill by name or by match can end the
 * run itself.
 */
export const processRule =
  "Never stop, kill, or signal a process that your own commands did not start, and never select processes by name or by a command-line match. End only the exact PIDs your own commands started.";

/**
 * Names the one way that a Codex shell command can reach the network despite the sandbox. The
 * orchestrator and reviewer prompts share it.
 */
export const SHELL_EXCEPTION =
  "A user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception. That rule can run a shell command with an expansion outside the sandbox, with network. The runtime does not prevent that.";
