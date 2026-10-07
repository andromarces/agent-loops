import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    testTimeout: 15000,
    setupFiles: ["./tests/setup-tmpdir.mjs"],
    // A suite that runs inside a role turn inherits the child marker (issue #392).
    env: { AGENT_LOOP_SPAWNED_ROLE: "" },
  },
  // Oxfmt and Oxlint defaults; the empty blocks keep both tools on this file.
  fmt: {},
  lint: {},
  // Format only, JS/TS only: the pre-commit hook never lints and never touches
  // Markdown, YAML, TOML, or lockfiles.
  staged: {
    "*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}": "vp fmt",
  },
});
