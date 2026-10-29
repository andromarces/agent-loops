import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A machine-wide directory: the environment variable `envName` when non-empty, else `<os tmpdir>/agent-loops/<leaf>`. */
export function tmpRoot(envName, leaf) {
  const override = process.env[envName];
  return override ? resolve(override) : join(tmpdir(), "agent-loops", leaf);
}
