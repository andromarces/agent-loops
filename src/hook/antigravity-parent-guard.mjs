// Antigravity CLI PreToolUse hook for the parent-edit guard (#88). Antigravity
// names the session `conversationId` and the tool `toolCall.name`. It blocks a
// tool call when a hook prints `{}`, prints an empty decision, or exits
// non-zero, so every allow path here prints nothing and exits 0: the normal
// permission flow stays intact. One deny object prints only for a guarded tool
// call from the registered parent while its run is non-terminal. Fail-open by
// design: an unparseable payload, an absent record, a terminal lifecycle, and a
// lookup error all deny nothing.
import { ANTIGRAVITY_GUARDED_TOOLS } from "./antigravity-guarded-tools.mjs";
import { runParentGuard } from "./decision.mjs";

await runParentGuard((reason) => ({ decision: "deny", reason }), {
  readSessionId: (input) =>
    typeof input?.conversationId === "string" ? input.conversationId : null,
  isGuarded: (input) => ANTIGRAVITY_GUARDED_TOOLS.has(input?.toolCall?.name),
});
