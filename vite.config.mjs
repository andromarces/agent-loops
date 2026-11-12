import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    testTimeout: 15000,
    globalSetup: ["./tests/git-template-setup.mjs"],
    setupFiles: ["./tests/setup-tmpdir.mjs"],
  },
  // Oxfmt and Oxlint defaults. The empty blocks keep both tools on this file.
  fmt: {},
  lint: {},
  // Format only, JS/TS only: the pre-commit hook never lints and never touches
  // Markdown, YAML, TOML, or lockfiles.
  staged: {
    "*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}": "vp fmt",
  },
});
