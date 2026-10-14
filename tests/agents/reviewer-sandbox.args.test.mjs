import { expect, test, vi } from "vite-plus/test";
import { defaultAgents } from "../../src/agents/index.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Usefulness: verifies requirement "the other four adapters keep their arguments in every reviewer
// sandbox mode" (ADR 0038): only the Codex adapter reads the reviewer `sandbox` input, so a changed
// argv here would apply a mode to a CLI that has none. A resumed session avoids the random id.
test.each(["claude", "agy", "copilot", "opencode"])(
  "%s passes identical arguments whatever the reviewer sandbox input",
  async (kind) => {
    const argvFor = async (sandbox) => {
      vi.mocked(exec).mockReset();
      vi.mocked(exec).mockResolvedValue({ stdout: "", stderr: "" });
      const state = { kind, sessionId: "sess-1", model: null, effort: null };
      // The empty reply fails the parse of the adapter, which is not under test: the argv is.
      await defaultAgents[kind]
        .run(state, "p", { cwd: "/dir", readOnly: true, ...(sandbox ? { sandbox } : {}) })
        .catch(() => {});
      expect(vi.mocked(exec)).toHaveBeenCalled();
      const [command, args, options] = vi.mocked(exec).mock.calls[0];
      return { command, args, env: options?.env };
    };

    const baseline = await argvFor(undefined);
    for (const sandbox of ["none", "read-only", "workspace-write"]) {
      expect(await argvFor(sandbox)).toEqual(baseline);
    }
  },
);
