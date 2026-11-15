import { readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";

const weights = JSON.parse(readFileSync(new URL("./shard-weights.json", import.meta.url), "utf8"));

/**
 * Per-file durations measured on Windows, in milliseconds, keyed by root-relative path.
 * Files added after the measurement are absent and estimated from their byte size.
 */
export const testFileDurations = weights.files;

function estimateMs(moduleId, root) {
  const measured = testFileDurations[relative(root, moduleId).split(sep).join("/")];
  if (typeof measured === "number") return measured;
  try {
    return Math.max(50, Math.round(statSync(moduleId).size * weights.millisecondsPerByte));
  } catch {
    return 50;
  }
}

function byDurationDescending(specs, root) {
  return specs
    .map((spec) => ({ spec, ms: estimateMs(spec.moduleId, root) }))
    .sort(
      (left, right) => right.ms - left.ms || (left.spec.moduleId < right.spec.moduleId ? -1 : 1),
    );
}

/**
 * Splits entries into `count` buckets of near-equal estimated duration.
 * Each entry lands in exactly one bucket, including entries with an estimate.
 */
function balance(entries, count) {
  const buckets = Array.from({ length: count }, () => ({ ms: 0, entries: [] }));
  for (const entry of entries) {
    let target = buckets[0];
    for (const bucket of buckets) {
      const lighter = bucket.ms < target.ms;
      const fewer = bucket.ms === target.ms && bucket.entries.length < target.entries.length;
      if (lighter || fewer) target = bucket;
    }
    target.ms += entry.ms;
    target.entries.push(entry);
  }
  return buckets.map((bucket) => bucket.entries);
}

/**
 * Vitest sequencer that replaces the default path-hash shard split with a
 * duration-balanced split, so shard membership tracks measured cost.
 */
export class ShardSequencer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async shard(specs) {
    const { index, count } = this.ctx.config.shard;
    const ordered = byDurationDescending(specs, this.ctx.config.root);
    return balance(ordered, count)[index - 1].map((entry) => entry.spec);
  }

  async sort(specs) {
    return byDurationDescending(specs, this.ctx.config.root).map((entry) => entry.spec);
  }
}
