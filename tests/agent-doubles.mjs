/**
 * Runs an ordered list of fake replies and records each call in `recorded`.
 * A reply may be a value or a `(state, prompt, options)` function; values are
 * returned as-is, functions are called instead.
 */
export function scripted(replies) {
  let callIndex = 0;
  const recorded = [];
  return {
    recorded,
    async run(state, prompt, options) {
      state.sessionId = state.sessionId ?? `${state.kind}-sess`;
      recorded.push({ prompt, options, sessionId: state.sessionId });
      const reply = replies[callIndex++];
      if (typeof reply === "function") {
        return reply(state, prompt, options);
      }
      return reply;
    },
  };
}

export const ok = (stdout) => ({ status: 0, stdout, stderr: "", timedOut: false });

/**
 * Agents for a headless `main` run: the orchestrator `codex` answers each call with the next entry
 * of `replies`, and `claude` and `agy` answer with a fixed text.
 */
export function continueAgents(replies) {
  let call = 0;
  const child = (text) => ({
    async run(state) {
      state.sessionId ??= "s";
      return text;
    },
  });
  return {
    codex: {
      async run(state) {
        state.sessionId ??= "s";
        return replies[call++];
      },
    },
    claude: child("worker ok"),
    agy: child("reviewer ok"),
  };
}
