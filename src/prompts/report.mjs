/**
 * Closing block every child turn must end with. The orchestrator sees only the child's final
 * response, so the block carries the reasoning and open items it would otherwise re-derive.
 */
export const reportBlock = `
End your response with this block, kept short:
Conclusion: one or two sentences.
Why: the decisive evidence behind the conclusion.
Blockers: anything unresolved that the next turn must know, or "none".
`.trim();
