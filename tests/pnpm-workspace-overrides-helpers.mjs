const KEYS = ["vite", "vitest"];

/** Reads the flat `overrides:` map of `pnpm-workspace.yaml` without a YAML parser. */
export function readOverrides(yaml) {
  const block = yaml.match(/^overrides:\r?\n((?:[ \t]+.*\r?\n?)+)/m)?.[1] ?? "";
  const overrides = {};
  for (const line of block.split(/\r?\n/)) {
    const entry = line.match(/^\s+([\w@/.-]+):\s*(\S+)\s*$/);
    if (entry) overrides[entry[1]] = entry[2];
  }
  return overrides;
}

/**
 * Compares the `vite` and `vitest` overrides to the `vite-plus` dependencies.
 * Returns one message per key that is missing from either input or that differs;
 * an empty array means both keys match.
 */
export function findOverrideProblems(overrides, dependencies, vitePlusVersion) {
  const problems = [];
  for (const key of KEYS) {
    const pinned = overrides[key];
    const wanted = dependencies[key];
    if (pinned === undefined) {
      problems.push(`  ${key}: missing from the overrides in pnpm-workspace.yaml`);
    }
    if (wanted === undefined) {
      problems.push(`  ${key}: missing from the dependencies of vite-plus@${vitePlusVersion}`);
    }
    if (pinned === undefined || wanted === undefined) continue;
    if (pinned !== wanted) {
      problems.push(
        `  ${key}: pnpm-workspace.yaml has "${pinned}", vite-plus@${vitePlusVersion} depends on "${wanted}"`,
      );
    }
  }
  return problems;
}
