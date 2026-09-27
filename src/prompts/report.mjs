/**
 * Closing block every child turn must end with. The orchestrator sees only the child's final
 * response, so the block carries the reasoning and open items it would otherwise re-derive.
 */
export const reportBlock = `
End your response with this block, kept short. Each label takes one line, plain at column 0; a label with a list under it, an indented label, or a decorated label makes the whole block unparseable:
Conclusion: one or two sentences.
Why: the decisive evidence behind the conclusion.
Blockers: anything unresolved that the next turn must know, or "none".
Notes: non-blocking findings the next turn does not need to act on, or "none".
Deferred: items found but left out of scope, or "none".
`.trim();
