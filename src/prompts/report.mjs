/**
 * Closing block every child turn must end with. The orchestrator sees only the child's final
 * response, so the block carries the reasoning and open items it would otherwise re-derive.
 */
export const reportBlock = `
End your response with this block, kept short:
Conclusion: one or two sentences.
Why: the decisive evidence behind the conclusion.
Blockers: anything unresolved that the next turn must know, or "none".
Notes: non-blocking findings the next turn does not need to act on, or "none". One line.
Deferred: items found but left out of scope, or "none". One line.
Each label takes one line. An empty label with lines under it, such as bullets, makes the whole block unreadable.
`.trim();
